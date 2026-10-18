package main

import (
	"bytes"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/xuri/excelize/v2"
)

func writeFile(t *testing.T, name, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func mustOpen(t *testing.T, path string) *Doc {
	t.Helper()
	d, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	return d
}

func mustApply(t *testing.T, d *Doc, ops ...Op) *Result {
	t.Helper()
	res, err := d.Apply(ops)
	if err != nil {
		t.Fatal(err)
	}
	return res
}

func TestCSVRoundTripKeepsDialect(t *testing.T) {
	in := "\xef\xbb\xbfname;note\r\nAda;\"says \"\"hi\"\"; twice\"\r\nBo;\r\n"
	path := writeFile(t, "people.csv", in)
	d := mustOpen(t, path)
	if d.comma != ';' || !d.bom || !d.crlf {
		t.Fatalf("dialect = %q bom=%v crlf=%v", d.comma, d.bom, d.crlf)
	}
	want := [][]string{{"name", "note"}, {"Ada", `says "hi"; twice`}, {"Bo", ""}}
	if !reflect.DeepEqual(d.Sheets[0].Values, want) {
		t.Fatalf("values = %q", d.Sheets[0].Values)
	}
	if err := d.Save(false); err != nil {
		t.Fatal(err)
	}
	out, _ := os.ReadFile(path)
	if string(out) != in {
		t.Fatalf("round trip changed the file:\n got %q\nwant %q", out, in)
	}
	info, _ := os.Stat(path)
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("mode = %v, want 0600 kept", info.Mode().Perm())
	}
}

func TestCSVOps(t *testing.T) {
	path := writeFile(t, "t.csv", "a,b\n1,2\n")
	d := mustOpen(t, path)
	mustApply(t, d,
		Op{Op: "set", R: 3, C: 2, Text: "x"},   // grows the sheet
		Op{Op: "insertRows", R: 1, N: 1},       // blank row under the header
		Op{Op: "set", R: 1, C: 0, Text: "new"}, //
		Op{Op: "deleteCols", C: 1, N: 1},       // drop column b
		Op{Op: "insertCols", C: 0, N: 1},       // blank first column
		Op{Op: "set", R: 0, C: 0, Text: "id"},  //
		Op{Op: "set", R: 9, C: 9, Text: ""},    // clearing an empty cell doesn't grow
		Op{Op: "deleteRows", R: 50, N: 2},      // out of range: no-op
	)
	if !d.Dirty {
		t.Fatal("doc should be dirty")
	}
	if err := d.Save(false); err != nil {
		t.Fatal(err)
	}
	out, _ := os.ReadFile(path)
	want := "id,a,\n,new,\n,1,\n,,\n,,x\n"
	if string(out) != want {
		t.Fatalf("saved:\n%s\nwant:\n%s", out, want)
	}
}

func TestSaveRefusesToClobberOutsideChanges(t *testing.T) {
	path := writeFile(t, "t.csv", "a\n")
	d := mustOpen(t, path)
	mustApply(t, d, Op{Op: "set", R: 0, C: 0, Text: "mine"})
	later := time.Now().Add(time.Hour)
	os.WriteFile(path, []byte("theirs\n"), 0o644)
	os.Chtimes(path, later, later)
	if err := d.Save(false); err != ErrConflict {
		t.Fatalf("Save = %v, want ErrConflict", err)
	}
	if err := d.Save(true); err != nil {
		t.Fatal(err)
	}
	if out, _ := os.ReadFile(path); string(out) != "mine\n" {
		t.Fatalf("forced save wrote %q", out)
	}
	// After a save, another save goes through without force.
	mustApply(t, d, Op{Op: "set", R: 0, C: 0, Text: "again"})
	if err := d.Save(false); err != nil {
		t.Fatal(err)
	}
}

func TestNewFileIsCreatedOnSave(t *testing.T) {
	for _, name := range []string{"new.csv", "new.xlsx"} {
		path := filepath.Join(t.TempDir(), name)
		d := mustOpen(t, path)
		mustApply(t, d, Op{Op: "set", R: 0, C: 0, Text: "hello"})
		if err := d.Save(false); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if reopened := mustOpen(t, path); at(reopened.Sheets[0].Values, 0, 0) != "hello" {
			t.Fatalf("%s: got %q", name, reopened.Sheets[0].Values)
		}
	}
}

func makeXLSX(t *testing.T) string {
	t.Helper()
	f := excelize.NewFile()
	f.SetSheetName("Sheet1", "Data")
	f.SetCellValue("Data", "A1", "Item")
	f.SetCellValue("Data", "B1", "Price")
	f.SetCellValue("Data", "A2", "pen")
	f.SetCellValue("Data", "B2", 1.5)
	f.SetCellValue("Data", "A3", "pad")
	f.SetCellValue("Data", "B3", 2.25)
	f.SetCellFormula("Data", "B4", "SUM(B2:B3)")
	money, _ := f.NewStyle(&excelize.Style{NumFmt: 4}) // #,##0.00
	f.SetCellStyle("Data", "B2", "B4", money)
	f.NewSheet("Notes")
	f.SetCellFormula("Notes", "A1", "Data!B4*2")
	path := filepath.Join(t.TempDir(), "book.xlsx")
	if err := f.SaveAs(path); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestXLSXEditRecalcsFormulas(t *testing.T) {
	d := mustOpen(t, makeXLSX(t))
	if got := len(d.Sheets); got != 2 {
		t.Fatalf("%d sheets", got)
	}
	data := d.Sheets[0]
	if data.Edit["3,1"] != "=SUM(B2:B3)" {
		t.Fatalf("formula edit text = %q", data.Edit["3,1"])
	}
	res := mustApply(t, d, Op{Op: "set", R: 1, C: 1, Text: "10"})
	if v := at(data.Values, 1, 1); v != "10.00" {
		t.Fatalf("B2 display = %q, want number format kept", v)
	}
	if v := at(data.Values, 3, 1); v != "12.25" {
		t.Fatalf("B4 = %q, want recalculated 12.25", v)
	}
	if v := at(d.Sheets[1].Values, 0, 0); v != "24.5" {
		t.Fatalf("Notes!A1 = %q, want cross-sheet recalc 24.5", v)
	}
	if len(res.Updates) < 3 {
		t.Fatalf("updates = %+v", res.Updates)
	}

	// A typed formula is stored as a formula and computed.
	mustApply(t, d, Op{Op: "set", R: 4, C: 1, Text: "=B4/2"})
	if v := at(data.Values, 4, 1); v != "6.125" {
		t.Fatalf("B5 = %q", v)
	}
}

func TestXLSXInsertRowAdjustsFormulasAndSaves(t *testing.T) {
	path := makeXLSX(t)
	d := mustOpen(t, path)
	res := mustApply(t, d, Op{Op: "insertRows", R: 2, N: 1})
	if res.Sheets == nil {
		t.Fatal("structural edit should send a full refresh")
	}
	if e := d.Sheets[0].Edit["4,1"]; e != "=SUM(B2:B4)" {
		t.Fatalf("moved formula = %q, want range widened to B2:B4", e)
	}
	mustApply(t, d, Op{Op: "set", R: 2, C: 1, Text: "100"})
	if v := at(d.Sheets[0].Values, 2, 1); v != "100.00" {
		t.Fatalf("new row B3 = %q, want the number format of the row above", v)
	}
	if err := d.Save(false); err != nil {
		t.Fatal(err)
	}

	f, err := excelize.OpenFile(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if v, _ := f.CalcCellValue("Data", "B5"); v != "103.75" {
		t.Fatalf("reopened B5 = %q", v)
	}
	if s, _ := f.GetCellStyle("Data", "B2"); s == 0 {
		t.Fatal("cell style lost on save")
	}
}

func TestParseNumber(t *testing.T) {
	for in, want := range map[string]bool{
		"1": true, "-2.5": true, "1e3": true, ".5": true,
		"": false, " 1": false, "NaN": false, "Inf": false, "0x10": false, "1_000": false, "1,000": false, "abc": false,
	} {
		if _, ok := parseNumber(in); ok != want {
			t.Errorf("parseNumber(%q) ok = %v, want %v", in, ok, want)
		}
	}
}

func TestXLSXWithoutCachedValuesIsComputedOnOpen(t *testing.T) {
	f := excelize.NewFile()
	f.SetCellValue("Sheet1", "A1", 2)
	f.SetCellValue("Sheet1", "A2", 3)
	f.SetCellFormula("Sheet1", "A3", "A1*A2") // excelize, like openpyxl, writes no cached value
	path := filepath.Join(t.TempDir(), "nocache.xlsx")
	if err := f.SaveAs(path); err != nil {
		t.Fatal(err)
	}
	d := mustOpen(t, path)
	if v := at(d.Sheets[0].Values, 2, 0); v != "6" {
		t.Fatalf("A3 = %q, want 6", v)
	}
}

func TestShiftRefs(t *testing.T) {
	for _, tc := range []struct {
		in   string
		dr   int
		want string
	}{
		{"SUM(B2:C2)", 3, "SUM(B5:C5)"},
		{"$A$1+A$1+$A1+A1", 2, "$A$1+A$1+$A3+A3"},
		{"Data!B4*2", 1, "Data!B5*2"},
		{"'Q1 2024'!A1&\"A1\"", 1, "'Q1 2024'!A2&\"A1\""},
		{"LOG10(A1)", 1, "LOG10(A2)"},
		{"A1-1", -1, "#REF!-1"},
		{"Q1!A1", 1, "Q1!A2"},
	} {
		if got := shiftRefs(tc.in, tc.dr); got != tc.want {
			t.Errorf("shiftRefs(%q, %d) = %q, want %q", tc.in, tc.dr, got, tc.want)
		}
	}
}

func TestReorderCSV(t *testing.T) {
	d := mustOpen(t, writeFile(t, "t.csv", "n\nc\na\nb\n"))
	mustApply(t, d, Op{Op: "reorder", R: 1, Order: []int{2, 3, 1}})
	want := [][]string{{"n"}, {"a"}, {"b"}, {"c"}}
	if !reflect.DeepEqual(d.Sheets[0].Values, want) {
		t.Fatalf("values = %q", d.Sheets[0].Values)
	}
	for _, bad := range [][]int{{1, 1, 2}, {0, 1, 2}, {1, 2, 3, 4}} {
		if _, err := d.Apply([]Op{{Op: "reorder", R: 1, Order: bad}}); err == nil {
			t.Errorf("reorder %v should be rejected", bad)
		}
	}
}

func TestReorderXLSXMovesFormulasStylesAndTypes(t *testing.T) {
	f := excelize.NewFile()
	rows := [][]any{{"Item", "Price", "Double"}, {"pen", 3, nil}, {"007", 1, nil}, {"pad", 2, nil}}
	for r, row := range rows {
		for c, v := range row {
			ref, _ := excelize.CoordinatesToCellName(c+1, r+1)
			if v != nil {
				f.SetCellValue("Sheet1", ref, v)
			}
		}
	}
	// A shared formula, as Excel writes when you fill down.
	shared := excelize.STCellFormulaTypeShared
	ref := "C2:C4"
	f.SetCellFormula("Sheet1", "C2", "B2*2", excelize.FormulaOpts{Type: &shared, Ref: &ref})
	bold, _ := f.NewStyle(&excelize.Style{Font: &excelize.Font{Bold: true}})
	f.SetCellStyle("Sheet1", "A4", "A4", bold)
	path := filepath.Join(t.TempDir(), "sort.xlsx")
	if err := f.SaveAs(path); err != nil {
		t.Fatal(err)
	}

	d := mustOpen(t, path)
	// Sort by price ascending: rows 3 (007,1), 4 (pad,2), 2 (pen,3).
	mustApply(t, d, Op{Op: "reorder", R: 1, Order: []int{2, 3, 1}})
	s := d.Sheets[0]
	for r, want := range [][]string{{"007", "1", "2"}, {"pad", "2", "4"}, {"pen", "3", "6"}} {
		if got := s.Values[r+1]; !reflect.DeepEqual(got, want) {
			t.Fatalf("row %d = %q, want %q", r+2, got, want)
		}
	}
	if e := s.Edit["1,2"]; e != "=B2*2" {
		t.Fatalf("C2 formula = %q", e)
	}
	if err := d.Save(false); err != nil {
		t.Fatal(err)
	}
	g, err := excelize.OpenFile(path)
	if err != nil {
		t.Fatal(err)
	}
	defer g.Close()
	if typ, _ := g.GetCellType("Sheet1", "A2"); typ != excelize.CellTypeSharedString && typ != excelize.CellTypeInlineString {
		t.Fatalf("\"007\" should stay text, got type %v", typ)
	}
	if st, _ := g.GetCellStyle("Sheet1", "A3"); st != bold {
		t.Fatalf("bold style should move with \"pad\" to A3, got style %d", st)
	}
	if v, _ := g.CalcCellValue("Sheet1", "C4"); v != "6" {
		t.Fatalf("C4 = %q after reopen", v)
	}
}

func TestBannerHasNoColorWhenNotATerminal(t *testing.T) {
	var buf bytes.Buffer
	printBanner(&buf, "orders.csv", "http://127.0.0.1:1/#tok")
	out := buf.String()
	if strings.Contains(out, "\x1b[") {
		t.Fatal("banner should have no color codes outside a terminal")
	}
	for _, want := range []string{"┌──┐", "orders.csv", "http://127.0.0.1:1/#tok", "Ctrl+C to quit"} {
		if !strings.Contains(out, want) {
			t.Errorf("banner is missing %q", want)
		}
	}
}
