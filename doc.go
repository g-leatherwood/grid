package main

import (
	"bytes"
	"encoding/csv"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/xuri/excelize/v2"
)

// maxRecalc caps how many formula cells are recomputed after an edit, so a
// huge workbook stays responsive. Excel recalculates everything on open anyway.
const maxRecalc = 20000

// Sheet is what the browser sees: display values plus, for xlsx, the text you
// get when editing a cell (its formula or raw number) where that differs from
// the display value. Edit keys are "row,col", zero-based.
type Sheet struct {
	Name   string            `json:"name"`
	Values [][]string        `json:"values"`
	Edit   map[string]string `json:"edit"`
}

// Op is one edit sent by the browser. Row and column are zero-based.
type Op struct {
	Op    string `json:"op"` // set, insertRows, deleteRows, insertCols, deleteCols, reorder
	Sheet int    `json:"sheet"`
	R     int    `json:"r"`
	C     int    `json:"c"`
	N     int    `json:"n"`
	Text  string `json:"text"`
	// For reorder (a sort): row R+i gets the row that was at Order[i].
	Order []int `json:"order,omitempty"`
}

// Update reports a cell whose value changed as a side effect of an edit,
// such as a formula that was recalculated.
type Update struct {
	Sheet int    `json:"sheet"`
	R     int    `json:"r"`
	C     int    `json:"c"`
	V     string `json:"v"`
	E     string `json:"e,omitempty"`
}

type Result struct {
	Updates []Update `json:"updates"`
	Sheets  []*Sheet `json:"sheets,omitempty"` // full refresh after a structural xlsx edit
	Dirty   bool     `json:"dirty"`
}

var ErrConflict = errors.New("file changed on disk since it was opened")

type Doc struct {
	mu     sync.Mutex
	Path   string
	Format string // "csv" or "xlsx"
	Sheets []*Sheet
	Dirty  bool
	exists bool
	mtime  time.Time

	// csv
	comma rune
	bom   bool
	crlf  bool

	// xlsx
	xf       *excelize.File
	formulas map[int]map[[2]int]bool // sheet -> formula cells
	recalc   bool                    // cached values are stale; compute formulas ourselves
}

func formatFor(path string) (string, error) {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".csv", ".tsv", ".txt":
		return "csv", nil
	case ".xlsx", ".xlsm":
		return "xlsx", nil
	case ".xls":
		return "", fmt.Errorf("%s: old .xls files aren't supported; save it as .xlsx first", path)
	}
	return "", fmt.Errorf("%s: unsupported file type (use .csv, .tsv or .xlsx)", path)
}

func Open(path string) (*Doc, error) {
	format, err := formatFor(path)
	if err != nil {
		return nil, err
	}
	d := &Doc{Path: path, Format: format}
	info, err := os.Stat(path)
	switch {
	case err == nil:
		d.exists = true
		d.mtime = info.ModTime()
	case errors.Is(err, os.ErrNotExist):
	default:
		return nil, err
	}
	if format == "csv" {
		return d, d.loadCSV()
	}
	return d, d.loadXLSX()
}

// ---- CSV ----

func (d *Doc) loadCSV() error {
	d.comma = ','
	if strings.ToLower(filepath.Ext(d.Path)) == ".tsv" {
		d.comma = '\t'
	}
	name := strings.TrimSuffix(filepath.Base(d.Path), filepath.Ext(d.Path))
	if !d.exists {
		d.Sheets = []*Sheet{{Name: name, Values: [][]string{}, Edit: map[string]string{}}}
		return nil
	}
	data, err := os.ReadFile(d.Path)
	if err != nil {
		return err
	}
	if b, ok := bytes.CutPrefix(data, []byte("\xef\xbb\xbf")); ok {
		data, d.bom = b, true
	}
	firstLine, _, _ := bytes.Cut(data, []byte("\n"))
	d.crlf = bytes.HasSuffix(firstLine, []byte("\r"))
	if d.comma == ',' {
		d.comma = sniffDelimiter(firstLine)
	}
	r := csv.NewReader(bytes.NewReader(data))
	r.Comma = d.comma
	r.FieldsPerRecord = -1
	r.LazyQuotes = true
	var rows [][]string
	for {
		rec, err := r.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			return fmt.Errorf("%s: %w", d.Path, err)
		}
		rows = append(rows, rec)
	}
	d.Sheets = []*Sheet{{Name: name, Values: rows, Edit: map[string]string{}}}
	return nil
}

// sniffDelimiter picks whichever of comma, semicolon, tab or pipe appears
// most often in the header line.
func sniffDelimiter(line []byte) rune {
	best, bestN := ',', 0
	for _, c := range []rune{',', ';', '\t', '|'} {
		if n := bytes.Count(line, []byte(string(c))); n > bestN {
			best, bestN = c, n
		}
	}
	return best
}

func (d *Doc) saveCSV(tmp string) error {
	rows := d.Sheets[0].Values
	// Drop trailing empty rows and square everything up to the widest used column.
	width := 0
	last := -1
	for i, row := range rows {
		for j := len(row) - 1; j >= 0; j-- {
			if row[j] != "" {
				width = max(width, j+1)
				last = i
				break
			}
		}
	}
	var buf bytes.Buffer
	if d.bom {
		buf.WriteString("\xef\xbb\xbf")
	}
	w := csv.NewWriter(&buf)
	w.Comma = d.comma
	w.UseCRLF = d.crlf
	for _, row := range rows[:last+1] {
		out := make([]string, width)
		copy(out, row)
		if err := w.Write(out); err != nil {
			return err
		}
	}
	w.Flush()
	if err := w.Error(); err != nil {
		return err
	}
	return os.WriteFile(tmp, buf.Bytes(), 0o644)
}

// ---- XLSX ----

func (d *Doc) loadXLSX() error {
	if d.exists {
		f, err := excelize.OpenFile(d.Path)
		if err != nil {
			return fmt.Errorf("%s: %w", d.Path, err)
		}
		d.xf = f
	} else {
		d.xf = excelize.NewFile()
	}
	return d.readAllSheets()
}

func (d *Doc) readAllSheets() error {
	d.Sheets = nil
	d.formulas = map[int]map[[2]int]bool{}
	for i, name := range d.xf.GetSheetList() {
		s, err := d.readSheet(i, name)
		if err != nil {
			return err
		}
		d.Sheets = append(d.Sheets, s)
	}
	// Files written by scripts (openpyxl, pandas) often have no cached formula
	// results, so compute any formula that has no value yet.
	d.recalcFormulas(!d.recalc)
	return nil
}

func (d *Doc) readSheet(idx int, name string) (*Sheet, error) {
	display, err := d.xf.GetRows(name)
	if err != nil {
		return nil, err
	}
	raw, err := d.xf.GetRows(name, excelize.Options{RawCellValue: true})
	if err != nil {
		return nil, err
	}
	s := &Sheet{Name: name, Values: display, Edit: map[string]string{}}
	d.formulas[idx] = map[[2]int]bool{}
	for r := range max(len(display), len(raw)) {
		width := 0
		if r < len(display) {
			width = len(display[r])
		}
		if r < len(raw) {
			width = max(width, len(raw[r]))
		}
		for c := range width {
			ref, _ := excelize.CoordinatesToCellName(c+1, r+1)
			if f, _ := d.xf.GetCellFormula(name, ref); f != "" {
				s.Edit[key(r, c)] = "=" + f
				d.formulas[idx][[2]int{r, c}] = true
				continue
			}
			if rv, dv := at(raw, r, c), at(display, r, c); rv != dv {
				s.Edit[key(r, c)] = rv
			}
		}
	}
	return s, nil
}

func (d *Doc) setXLSX(op Op) error {
	name := d.Sheets[op.Sheet].Name
	ref, err := excelize.CoordinatesToCellName(op.C+1, op.R+1)
	if err != nil {
		return err
	}
	text := op.Text
	cell := [2]int{op.R, op.C}
	delete(d.formulas[op.Sheet], cell)
	switch {
	case strings.HasPrefix(text, "=") && len(text) > 1:
		err = d.xf.SetCellFormula(name, ref, text[1:])
		d.formulas[op.Sheet][cell] = true
	case text == "":
		err = d.xf.SetCellValue(name, ref, nil)
	case isBool(text):
		err = d.xf.SetCellBool(name, ref, strings.EqualFold(text, "true"))
	default:
		if n, ok := parseNumber(text); ok {
			err = d.xf.SetCellFloat(name, ref, n, -1, 64)
		} else {
			err = d.xf.SetCellStr(name, ref, text)
		}
	}
	if err != nil {
		return err
	}
	d.recalc = true
	return nil
}

// reorderXLSX moves whole rows to sort them. Each cell keeps its type and
// style, and formulas that move are adjusted the way Excel adjusts them when
// it sorts: relative row references shift by however far the row moved.
func (d *Doc) reorderXLSX(op Op) error {
	name := d.Sheets[op.Sheet].Name
	type cellData struct {
		formula, raw string
		typ          excelize.CellType
		style        int
	}
	width := 0
	for _, old := range op.Order {
		width = max(width, len(d.Sheets[op.Sheet].Values[old]))
	}
	snap := make([][]cellData, len(op.Order))
	for i, old := range op.Order {
		snap[i] = make([]cellData, width)
		for c := range width {
			ref, _ := excelize.CoordinatesToCellName(c+1, old+1)
			cd := &snap[i][c]
			cd.formula, _ = d.xf.GetCellFormula(name, ref)
			cd.raw, _ = d.xf.GetCellValue(name, ref, excelize.Options{RawCellValue: true})
			cd.typ, _ = d.xf.GetCellType(name, ref)
			cd.style, _ = d.xf.GetCellStyle(name, ref)
		}
	}
	// Clear every formula first so no shared formula outlives its parent cell.
	for i := range op.Order {
		for c := range width {
			if snap[i][c].formula != "" {
				ref, _ := excelize.CoordinatesToCellName(c+1, op.R+i+1)
				d.xf.SetCellFormula(name, ref, "")
			}
		}
	}
	for i, old := range op.Order {
		row := op.R + i
		for c, cd := range snap[i] {
			ref, _ := excelize.CoordinatesToCellName(c+1, row+1)
			var err error
			switch {
			case cd.formula != "":
				err = d.xf.SetCellFormula(name, ref, shiftRefs(cd.formula, row-old))
			case cd.raw == "":
				err = d.xf.SetCellValue(name, ref, nil)
			case cd.typ == excelize.CellTypeSharedString || cd.typ == excelize.CellTypeInlineString || cd.typ == excelize.CellTypeError:
				err = d.xf.SetCellStr(name, ref, cd.raw)
			case cd.typ == excelize.CellTypeBool:
				err = d.xf.SetCellBool(name, ref, cd.raw == "1" || strings.EqualFold(cd.raw, "true"))
			default:
				if n, ok := parseNumber(cd.raw); ok {
					err = d.xf.SetCellFloat(name, ref, n, -1, 64)
				} else {
					err = d.xf.SetCellStr(name, ref, cd.raw)
				}
			}
			if err != nil {
				return err
			}
			if err := d.xf.SetCellStyle(name, ref, ref, cd.style); err != nil {
				return err
			}
		}
	}
	d.recalc = true
	return nil
}

// shiftRefs moves the relative row references in a formula by dr rows,
// leaving $-anchored rows, string literals and quoted sheet names alone.
func shiftRefs(f string, dr int) string {
	if dr == 0 {
		return f
	}
	var b strings.Builder
	for i := 0; i < len(f); {
		ch := f[i]
		if ch == '"' || ch == '\'' {
			j := i + 1
			for j < len(f) {
				if f[j] == ch {
					if j+1 < len(f) && f[j+1] == ch { // doubled quote is an escaped quote
						j += 2
						continue
					}
					break
				}
				j++
			}
			end := min(j+1, len(f))
			b.WriteString(f[i:end])
			i = end
			continue
		}
		if i == 0 || !isNameChar(f[i-1]) {
			if out, n, ok := shiftRef(f[i:], dr); ok {
				b.WriteString(out)
				i += n
				continue
			}
		}
		b.WriteByte(ch)
		i++
	}
	return b.String()
}

func isNameChar(c byte) bool {
	return c == '_' || c == '.' || c == '$' || c >= '0' && c <= '9' || c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z'
}

// shiftRef parses a cell reference like A1, $B$2 or xfd10 at the start of s.
func shiftRef(s string, dr int) (string, int, bool) {
	p := 0
	if p < len(s) && s[p] == '$' {
		p++
	}
	letters := p
	for p < len(s) && p-letters < 4 && (s[p] >= 'A' && s[p] <= 'Z' || s[p] >= 'a' && s[p] <= 'z') {
		p++
	}
	if n := p - letters; n < 1 || n > 3 {
		return "", 0, false
	}
	colEnd := p
	rowAbs := p < len(s) && s[p] == '$'
	if rowAbs {
		p++
	}
	digits := p
	for p < len(s) && s[p] >= '0' && s[p] <= '9' {
		p++
	}
	if p == digits {
		return "", 0, false
	}
	if p < len(s) && (isNameChar(s[p]) || s[p] == '(' || s[p] == '!' || s[p] == '\'') {
		return "", 0, false
	}
	row, _ := strconv.Atoi(s[digits:p])
	if rowAbs {
		return s[:p], p, true
	}
	row += dr
	if row < 1 || row > 1048576 {
		return "#REF!", p, true
	}
	return s[:colEnd] + strconv.Itoa(row), p, true
}

// copyStyle applies the style of cell (r, c) to the range (r0, c0):(r1, c1).
func (d *Doc) copyStyle(sheet string, r, c, r0, c0, r1, c1 int) {
	src, _ := excelize.CoordinatesToCellName(c+1, r+1)
	style, err := d.xf.GetCellStyle(sheet, src)
	if err != nil || style == 0 {
		return
	}
	from, _ := excelize.CoordinatesToCellName(c0+1, r0+1)
	to, _ := excelize.CoordinatesToCellName(c1+1, r1+1)
	d.xf.SetCellStyle(sheet, from, to, style)
}

// refreshCell re-reads one cell from the workbook into the sheet model.
func (d *Doc) refreshCell(si, r, c int) {
	name := d.Sheets[si].Name
	ref, _ := excelize.CoordinatesToCellName(c+1, r+1)
	s := d.Sheets[si]
	if d.formulas[si][[2]int{r, c}] {
		f, _ := d.xf.GetCellFormula(name, ref)
		v, err := d.xf.CalcCellValue(name, ref)
		if err != nil && v == "" {
			v = "#ERROR"
		}
		setAt(s, r, c, v)
		s.Edit[key(r, c)] = "=" + f
		return
	}
	v, _ := d.xf.GetCellValue(name, ref)
	rv, _ := d.xf.GetCellValue(name, ref, excelize.Options{RawCellValue: true})
	setAt(s, r, c, v)
	if rv != v {
		s.Edit[key(r, c)] = rv
	} else {
		delete(s.Edit, key(r, c))
	}
}

// recalcFormulas recomputes formula cells (only blank ones if onlyBlank) and
// returns the ones whose display value changed.
func (d *Doc) recalcFormulas(onlyBlank bool) []Update {
	var out []Update
	n := 0
	for si, cells := range d.formulas {
		name := d.Sheets[si].Name
		for cell := range cells {
			if n++; n > maxRecalc {
				return out
			}
			r, c := cell[0], cell[1]
			if onlyBlank && at(d.Sheets[si].Values, r, c) != "" {
				continue
			}
			ref, _ := excelize.CoordinatesToCellName(c+1, r+1)
			v, err := d.xf.CalcCellValue(name, ref)
			if err != nil && v == "" {
				continue // unsupported function: keep Excel's cached value
			}
			if v != at(d.Sheets[si].Values, r, c) {
				setAt(d.Sheets[si], r, c, v)
				out = append(out, Update{Sheet: si, R: r, C: c, V: v, E: d.Sheets[si].Edit[key(r, c)]})
			}
		}
	}
	return out
}

func (d *Doc) structuralXLSX(op Op) error {
	name := d.Sheets[op.Sheet].Name
	n := max(op.N, 1)
	switch op.Op {
	case "insertRows":
		if err := d.xf.InsertRows(name, op.R+1, n); err != nil {
			return err
		}
		// Like Excel, new rows take the formatting of the row above.
		if op.R > 0 && op.R-1 < len(d.Sheets[op.Sheet].Values) {
			for c := range d.Sheets[op.Sheet].Values[op.R-1] {
				d.copyStyle(name, op.R-1, c, op.R, c, op.R+n-1, c)
			}
		}
	case "deleteRows":
		for range n {
			if err := d.xf.RemoveRow(name, op.R+1); err != nil {
				return err
			}
		}
	case "insertCols":
		col, err := excelize.ColumnNumberToName(op.C + 1)
		if err != nil {
			return err
		}
		if err := d.xf.InsertCols(name, col, n); err != nil {
			return err
		}
		// New columns take the formatting of the column to their left.
		if op.C > 0 {
			for r := range d.Sheets[op.Sheet].Values {
				d.copyStyle(name, r, op.C-1, r, op.C, r, op.C+n-1)
			}
		}
	case "deleteCols":
		col, err := excelize.ColumnNumberToName(op.C + 1)
		if err != nil {
			return err
		}
		for range n {
			if err := d.xf.RemoveCol(name, col); err != nil {
				return err
			}
		}
	}
	return nil
}

// ---- ops shared by both formats ----

func (d *Doc) Apply(ops []Op) (*Result, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	res := &Result{Updates: []Update{}}
	structural := false
	type cell struct{ s, r, c int }
	var touched []cell
	for _, op := range ops {
		if op.Sheet < 0 || op.Sheet >= len(d.Sheets) || op.R < 0 || op.C < 0 {
			return nil, fmt.Errorf("bad op: %+v", op)
		}
		d.Dirty = true
		s := d.Sheets[op.Sheet]
		switch op.Op {
		case "set":
			if d.Format == "xlsx" {
				if err := d.setXLSX(op); err != nil {
					return nil, err
				}
				touched = append(touched, cell{op.Sheet, op.R, op.C})
			} else {
				setAt(s, op.R, op.C, op.Text)
			}
		case "insertRows", "deleteRows", "insertCols", "deleteCols":
			if d.Format == "xlsx" {
				if err := d.structuralXLSX(op); err != nil {
					return nil, err
				}
				structural = true
			} else {
				structuralCSV(s, op)
			}
		case "reorder":
			if !validOrder(op, len(s.Values)) {
				return nil, fmt.Errorf("bad reorder of %d rows at row %d", len(op.Order), op.R)
			}
			if d.Format == "xlsx" {
				if err := d.reorderXLSX(op); err != nil {
					return nil, err
				}
				structural = true
			} else {
				rows := make([][]string, len(op.Order))
				for i, old := range op.Order {
					rows[i] = s.Values[old]
				}
				copy(s.Values[op.R:], rows)
			}
		default:
			return nil, fmt.Errorf("unknown op %q", op.Op)
		}
	}
	if d.Format == "xlsx" {
		if structural {
			if err := d.readAllSheets(); err != nil {
				return nil, err
			}
			res.Sheets = d.Sheets
		} else {
			for _, t := range touched {
				d.refreshCell(t.s, t.r, t.c)
				s := d.Sheets[t.s]
				res.Updates = append(res.Updates, Update{Sheet: t.s, R: t.r, C: t.c, V: at(s.Values, t.r, t.c), E: s.Edit[key(t.r, t.c)]})
			}
			res.Updates = append(res.Updates, d.recalcFormulas(false)...)
		}
	}
	res.Dirty = d.Dirty
	return res, nil
}

// validOrder checks that a reorder is a permutation of rows R..R+len-1.
func validOrder(op Op, rows int) bool {
	if op.R+len(op.Order) > rows {
		return false
	}
	seen := make([]bool, len(op.Order))
	for _, old := range op.Order {
		i := old - op.R
		if i < 0 || i >= len(seen) || seen[i] {
			return false
		}
		seen[i] = true
	}
	return true
}

func structuralCSV(s *Sheet, op Op) {
	n := max(op.N, 1)
	switch op.Op {
	case "insertRows":
		if op.R > len(s.Values) {
			return
		}
		blank := make([][]string, n)
		s.Values = append(s.Values[:op.R], append(blank, s.Values[op.R:]...)...)
	case "deleteRows":
		if op.R >= len(s.Values) {
			return
		}
		end := min(op.R+n, len(s.Values))
		s.Values = append(s.Values[:op.R], s.Values[end:]...)
	case "insertCols":
		for i, row := range s.Values {
			if op.C > len(row) {
				continue
			}
			blank := make([]string, n)
			s.Values[i] = append(row[:op.C], append(blank, row[op.C:]...)...)
		}
	case "deleteCols":
		for i, row := range s.Values {
			if op.C >= len(row) {
				continue
			}
			end := min(op.C+n, len(row))
			s.Values[i] = append(row[:op.C], row[end:]...)
		}
	}
}

// Save writes the document back to its path atomically. Unless force is set,
// it refuses to overwrite a file someone else changed since we loaded it.
func (d *Doc) Save(force bool) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	info, err := os.Stat(d.Path)
	mode := os.FileMode(0o644)
	if err == nil {
		mode = info.Mode().Perm()
		if !force && (!d.exists || !info.ModTime().Equal(d.mtime)) {
			return ErrConflict
		}
	}
	dir, base := filepath.Split(d.Path)
	tmp := filepath.Join(dir, ".grid-"+strconv.Itoa(os.Getpid())+"-"+base)
	if d.Format == "csv" {
		err = d.saveCSV(tmp)
	} else {
		if d.recalc {
			on := true
			d.xf.SetCalcProps(&excelize.CalcPropsOptions{FullCalcOnLoad: &on})
		}
		err = d.xf.SaveAs(tmp)
	}
	if err != nil {
		os.Remove(tmp)
		return err
	}
	os.Chmod(tmp, mode)
	if err := os.Rename(tmp, d.Path); err != nil {
		os.Remove(tmp)
		return err
	}
	if info, err := os.Stat(d.Path); err == nil {
		d.mtime = info.ModTime()
	}
	d.exists = true
	d.Dirty = false
	return nil
}

func (d *Doc) IsDirty() bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.Dirty
}

// ---- helpers ----

func key(r, c int) string { return strconv.Itoa(r) + "," + strconv.Itoa(c) }

func at(rows [][]string, r, c int) string {
	if r < len(rows) && c < len(rows[r]) {
		return rows[r][c]
	}
	return ""
}

func setAt(s *Sheet, r, c int, v string) {
	if v == "" && at(s.Values, r, c) == "" {
		return // don't grow the sheet to store nothing
	}
	for len(s.Values) <= r {
		s.Values = append(s.Values, nil)
	}
	for len(s.Values[r]) <= c {
		s.Values[r] = append(s.Values[r], "")
	}
	s.Values[r][c] = v
}

func isBool(s string) bool {
	return strings.EqualFold(s, "true") || strings.EqualFold(s, "false")
}

func parseNumber(s string) (float64, bool) {
	t := strings.TrimSpace(s)
	if t != s || t == "" {
		return 0, false
	}
	n, err := strconv.ParseFloat(t, 64)
	if err != nil || strings.ContainsAny(t, "nNiIxX_") { // reject NaN, Inf, hex, 1_000
		return 0, false
	}
	return n, true
}
