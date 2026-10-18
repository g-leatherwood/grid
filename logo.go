package main

import (
	"fmt"
	"io"
	"strings"
)

// word is "grid" in figlet's slant font.
var word = []string{
	"               _     __",
	"   ____ ______(_)___/ /",
	"  / __ `/ ___/ / __  /",
	" / /_/ / /  / / /_/ /",
	" \\__, /_/  /_/\\__,_/",
	"/____/",
}

const tagline = "a quick peek"

const (
	cellW     = 6 // columns from one grid line to the next
	cellH     = 2 // rows from one grid line to the next
	padY      = 2 // rows of grid above the word
	sideCells = 2 // whole cells of grid beyond each end of the word
)

// logoLines draws the word centered on a grid with two whole cells either
// side of it, the tagline in the row of cells below it, and the version in
// the middle of the bottom line. The grid stops short of any text so it reads
// cleanly.
func logoLines(version string) []string {
	ww := 0
	for _, l := range word {
		ww = max(ww, len(l))
	}
	n := (ww+4+cellW-1)/cellW + 2*sideCells // cells under the word and its margin, plus the sides
	gw := n*cellW + 1
	gh := len(word) + 2*padY + 1
	canvas := make([][]byte, gh)
	for y := range canvas {
		canvas[y] = make([]byte, gw)
		for x := range canvas[y] {
			onH, onV := y%cellH == 0, x%cellW == 0
			switch {
			case onH && onV:
				canvas[y][x] = '+'
			case onH:
				canvas[y][x] = '-'
			case onV:
				canvas[y][x] = '|'
			default:
				canvas[y][x] = ' '
			}
		}
	}
	// put writes text at column x of row y, clearing the grid for gap columns
	// either side of it.
	put := func(y, x int, text string, gap int) {
		row := canvas[y]
		first := len(text) - len(strings.TrimLeft(text, " "))
		for i := max(0, x+first-gap); i < min(gw, x+len(text)+gap); i++ {
			row[i] = ' '
		}
		for i := range len(text) {
			if text[i] != ' ' {
				row[x+i] = text[i]
			}
		}
	}
	wx := (gw - ww) / 2
	for r, l := range word {
		put(padY+r, wx, l, 2)
	}
	put(gh-2, (gw-len(tagline))/2, tagline, 2)
	put(gh-1, (gw-len(version))/2, version, 1)
	lines := make([]string, gh)
	for y, row := range canvas {
		lines[y] = strings.TrimRight(string(row), " ")
	}
	return lines
}

// printBanner shows the logo, the file and the address when grid starts, all
// in the terminal's normal text color.
func printBanner(w io.Writer, path, url string) {
	fmt.Fprintln(w)
	v := version
	if v != "dev" {
		v = "v" + v
	}
	for _, l := range logoLines(v) {
		fmt.Fprintf(w, "  %s\n", l)
	}
	fmt.Fprintf(w, "\n  %s\n  %s\n\n  Ctrl+C to quit\n\n", path, url)
}
