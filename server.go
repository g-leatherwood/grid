package main

import (
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"path/filepath"
	"sync"
	"time"
)

//go:embed web
var webFS embed.FS

type server struct {
	doc     *Doc
	token   string
	addr    string        // host:port we listen on, for the Host header check
	quit    chan struct{} // closed when grid is quitting
	clients sync.WaitGroup
}

func (s *server) routes() http.Handler {
	static, _ := fs.Sub(webFS, "web")
	mux := http.NewServeMux()
	mux.Handle("GET /", http.FileServerFS(static))
	mux.HandleFunc("GET /api/doc", s.api(s.getDoc))
	mux.HandleFunc("POST /api/ops", s.api(s.postOps))
	mux.HandleFunc("POST /api/save", s.api(s.postSave))
	mux.HandleFunc("GET /api/events", s.events)
	return s.checkHost(mux)
}

// checkHost rejects requests whose Host isn't our loopback address, which
// blocks DNS-rebinding attacks from web pages you have open.
func (s *server) checkHost(next http.Handler) http.Handler {
	_, port, _ := net.SplitHostPort(s.addr)
	ok := map[string]bool{"127.0.0.1:" + port: true, "localhost:" + port: true}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !ok[r.Host] {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// api requires the per-run token, so other pages in your browser can't read
// or edit the file through this server.
func (s *server) api(h func(*http.Request) (any, error)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Grid-Token") != s.token {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		out, err := h(r)
		w.Header().Set("Content-Type", "application/json")
		if err != nil {
			status := http.StatusBadRequest
			if errors.Is(err, ErrConflict) {
				status = http.StatusConflict
			}
			w.WriteHeader(status)
			out = map[string]string{"error": err.Error()}
		}
		json.NewEncoder(w).Encode(out)
	}
}

// events is a server-sent event stream the page keeps open. When grid quits
// it sends "quit" so the page can close its tab. EventSource can't send
// headers, so this endpoint takes the token as a query parameter.
func (s *server) events(w http.ResponseWriter, r *http.Request) {
	fl, ok := w.(http.Flusher)
	if r.URL.Query().Get("t") != s.token || !ok {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	s.clients.Add(1)
	defer s.clients.Done()
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	fmt.Fprint(w, ": connected\n\n")
	fl.Flush()
	select {
	case <-s.quit:
		fmt.Fprint(w, "event: quit\ndata: bye\n\n")
		fl.Flush()
	case <-r.Context().Done():
	}
}

// shutdown tells open pages that grid is quitting and gives them a moment to
// receive it.
func (s *server) shutdown() {
	close(s.quit)
	done := make(chan struct{})
	go func() { s.clients.Wait(); close(done) }()
	select {
	case <-done:
		time.Sleep(150 * time.Millisecond) // let the last bytes reach the browser
	case <-time.After(time.Second):
	}
}

func (s *server) getDoc(*http.Request) (any, error) {
	d := s.doc
	d.mu.Lock()
	defer d.mu.Unlock()
	abs, _ := filepath.Abs(d.Path)
	return map[string]any{
		"name":   filepath.Base(d.Path),
		"path":   abs,
		"format": d.Format,
		"sheets": d.Sheets,
		"dirty":  d.Dirty,
	}, nil
}

func (s *server) postOps(r *http.Request) (any, error) {
	var body struct {
		Ops []Op `json:"ops"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		return nil, err
	}
	return s.doc.Apply(body.Ops)
}

func (s *server) postSave(r *http.Request) (any, error) {
	var body struct {
		Force bool `json:"force"`
	}
	json.NewDecoder(r.Body).Decode(&body)
	if err := s.doc.Save(body.Force); err != nil {
		return nil, err
	}
	return map[string]bool{"ok": true}, nil
}
