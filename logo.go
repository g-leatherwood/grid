package main

import (
	"fmt"
	"io"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// word is "grid" in figlet's "ANSI Shadow" font — big block letters drawn with
// box-drawing lines. logoLines frames it with a tagline and a rule.
var word = []string{
	" ██████╗ ██████╗ ██╗██████╗",
	"██╔════╝ ██╔══██╗██║██╔══██╗",
	"██║  ███╗██████╔╝██║██║  ██║",
	"██║   ██║██╔══██╗██║██║  ██║",
	"╚██████╔╝██║  ██║██║██████╔╝",
	" ╚═════╝ ╚═╝  ╚═╝╚═╝╚═════╝",
}

const tagline = "a quick peek"

// logoLines returns the banner: the big word, a blank line, a subtitle with
// the version, and a rule as wide as the subtitle. banner() colors it.
func logoLines(version string) []string {
	sub := tagline + " · " + version + " / open a CSV or Excel file in your browser"
	out := append([]string{}, word...)
	return append(out, "", sub, strings.Repeat("─", len([]rune(sub))))
}

// ANSI styling for the banner and status log, used only when the logger is
// told the output is a real terminal (see wantColor).
const (
	ansiReset = "\033[0m"
	ansiDim   = "\033[2m"
	ansiLogo  = "\033[1;38;5;64m"  // bold olive drab, for the big word
	ansiStep  = "\033[38;5;137m"   // tan, for READ, SERVE and OPEN
	ansiReady = "\033[1;38;5;106m" // bold yellow-green, for READY
)

// logger prints the startup banner and a timestamped status line per step,
// like "00:00.02  READY  Ctrl+C to quit". start is set when grid begins, so
// each line's timestamp shows how far into startup that step happened.
type logger struct {
	w     io.Writer
	color bool
	start time.Time
}

func newLogger(w io.Writer, color bool) *logger {
	return &logger{w: w, color: color, start: time.Now()}
}

// banner prints a blank line, the logo, and another blank line. In a terminal
// the big word is bold olive drab and the subtitle and rule are dim; piped, it's
// plain text. The word is the first len(word) lines; then a blank, the
// subtitle, and the rule.
func (l *logger) banner() {
	fmt.Fprintln(l.w)
	v := version
	if v != "dev" {
		v = "v" + v
	}
	lines := logoLines(v)
	for i, line := range lines {
		switch {
		case !l.color || i == len(word): // piped, or the blank separator line
			fmt.Fprintf(l.w, "  %s\n", line)
		case i < len(word):
			fmt.Fprintf(l.w, "  %s%s%s\n", ansiLogo, line, ansiReset)
		default: // subtitle and rule
			fmt.Fprintf(l.w, "  %s%s%s\n", ansiDim, line, ansiReset)
		}
	}
	fmt.Fprintln(l.w)
}

// step prints one status line: an elapsed timestamp, a short label, and a
// detail. READY is bold yellow-green, every other label tan.
func (l *logger) step(label, detail string) {
	ts := stamp(time.Since(l.start))
	if !l.color {
		fmt.Fprintf(l.w, "  %-8s  %-5s  %s\n", ts, label, detail)
		return
	}
	code := ansiStep
	if label == "READY" {
		code = ansiReady
	}
	fmt.Fprintf(l.w, "  %s%-8s%s  %s%-5s%s  %s\n", ansiDim, ts, ansiReset, code, label, ansiReset, detail)
}

// stamp formats a duration as mm:ss.cc, like the timestamps in the log.
func stamp(d time.Duration) string {
	cs := d.Milliseconds() / 10
	if cs < 0 {
		cs = 0
	}
	return fmt.Sprintf("%02d:%02d.%02d", cs/6000, (cs/100)%60, cs%100)
}

// fileDesc is the READ line's detail: the file, its format, and its size, like
// "orders.csv · CSV · 2,001 rows × 8 cols".
func fileDesc(path string, doc *Doc) string {
	rows, cols := 0, 0
	if len(doc.Sheets) > 0 {
		s := doc.Sheets[0]
		rows = len(s.Values)
		for _, r := range s.Values {
			if len(r) > cols {
				cols = len(r)
			}
		}
	}
	desc := fmt.Sprintf("%s · %s · %s rows × %d cols",
		filepath.Base(path), strings.ToUpper(doc.Format), commas(rows), cols)
	if strings.EqualFold(doc.Format, "xlsx") && len(doc.Sheets) > 1 {
		desc += fmt.Sprintf(" · %d sheets", len(doc.Sheets))
	}
	return desc
}

// commas groups a number with thousands separators: 2001 -> "2,001".
func commas(n int) string {
	s := strconv.Itoa(n)
	neg := strings.HasPrefix(s, "-")
	if neg {
		s = s[1:]
	}
	for i := len(s) - 3; i > 0; i -= 3 {
		s = s[:i] + "," + s[i:]
	}
	if neg {
		s = "-" + s
	}
	return s
}
