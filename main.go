// Command grid opens a CSV, TSV or xlsx file in a spreadsheet grid in your
// browser, served from a local web server, and saves edits back to the file.
package main

import (
	"crypto/rand"
	"encoding/hex"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"strconv"
	"time"
)

// version is set at build time by the release scripts.
var version = "dev"

func main() {
	port := flag.Int("port", 0, "port to listen on (default: any free port)")
	noOpen := flag.Bool("no-open", false, "print the URL instead of opening a browser")
	showVersion := flag.Bool("version", false, "print the version and exit")
	flag.Usage = func() {
		fmt.Fprintf(os.Stderr, "usage: grid [flags] FILE\n\nOpens FILE (.csv, .tsv or .xlsx) in a spreadsheet grid in your browser.\nA file that doesn't exist yet is created when you save.\n\nflags:\n")
		flag.PrintDefaults()
	}
	flag.Parse()
	if *showVersion {
		fmt.Println("grid", version)
		return
	}
	if flag.NArg() != 1 {
		flag.Usage()
		os.Exit(2)
	}
	if err := run(flag.Arg(0), *port, !*noOpen); err != nil {
		fmt.Fprintln(os.Stderr, "grid:", err)
		os.Exit(1)
	}
}

func run(path string, port int, open bool) error {
	doc, err := Open(path)
	if err != nil {
		return err
	}
	ln, err := net.Listen("tcp", "127.0.0.1:"+strconv.Itoa(port))
	if err != nil {
		return err
	}
	tok := make([]byte, 16)
	rand.Read(tok)
	s := &server{doc: doc, token: hex.EncodeToString(tok), addr: ln.Addr().String(), quit: make(chan struct{})}
	url := "http://" + s.addr + "/#" + s.token

	go func() {
		if err := http.Serve(ln, s.routes()); err != nil {
			fmt.Fprintln(os.Stderr, "grid:", err)
			os.Exit(1)
		}
	}()
	fmt.Printf("grid: %s at %s\n      Ctrl+C to quit\n", path, url)
	if open {
		openBrowser(url)
	}
	waitForQuit(doc)
	s.shutdown()
	return nil
}

// waitForQuit blocks until Ctrl+C. With unsaved changes it asks for a second
// Ctrl+C within a few seconds before exiting.
func waitForQuit(doc *Doc) {
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt)
	var warned time.Time
	for range sig {
		if !doc.IsDirty() || time.Since(warned) < 5*time.Second {
			return
		}
		warned = time.Now()
		fmt.Println("\ngrid: unsaved changes (Cmd+S in the browser saves). Ctrl+C again to quit anyway.")
	}
}

func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	if err := cmd.Start(); err != nil {
		fmt.Fprintln(os.Stderr, "grid: couldn't open a browser; open the URL above yourself")
	}
}
