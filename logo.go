package main

import (
	"fmt"
	"io"
	"strings"
)

// logo is "grid" drawn in spreadsheet cells.
const logo = `                              ┌──┐           ┌──┐
                              │  │           │  │
                              └──┘           ├──┤
                                             │  │
   ┌──┬──┬──┐  ┌──┐  ┌──┬──┐  ┌──┐     ┌──┬──┼──┤
   │  │  │  │  │  │  │  │  │  │  │     │  │  │  │
┌──┼──┴──┼──┤  ├──┼──┼──┴──┘  ├──┤  ┌──┼──┴──┼──┤
│  │     │  │  │  │  │        │  │  │  │     │  │
├──┤     ├──┤  ├──┼──┘        ├──┤  ├──┤     ├──┤
│  │     │  │  │  │           │  │  │  │     │  │
└──┼──┬──┼──┤  ├──┤           ├──┤  └──┼──┬──┼──┤
   │  │  │  │  │  │           │  │     │  │  │  │
   └──┴──┼──┤  └──┘           └──┘     └──┴──┴──┘
         │  │
┌──┬──┬──┼──┘
│  │  │  │
└──┴──┴──┘`

// printBanner shows the logo, the file and the address when grid starts, all
// in the terminal's normal text color.
func printBanner(w io.Writer, path, url string) {
	fmt.Fprintln(w)
	for _, line := range strings.Split(logo, "\n") {
		fmt.Fprintf(w, "  %s\n", line)
	}
	fmt.Fprintf(w, "\n  %s\n  %s\n\n  Ctrl+C to quit\n\n", path, url)
}
