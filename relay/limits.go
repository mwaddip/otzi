package main

import (
	"sync"
	"time"
)

// Limits defines resource limits for the relay server.
type Limits struct {
	MaxSessions     int
	MaxParties      int
	MaxMessageBytes int
	MaxPerIP        int
	PingInterval    time.Duration
	AbandonTimeout  time.Duration

	ipConns map[string]int
	mu      sync.Mutex
}

// AddIP increments the connection count for the given IP.
// Returns false if the IP has reached the connection limit.
func (l *Limits) AddIP(ip string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()

	if l.ipConns[ip] >= l.MaxPerIP {
		return false
	}
	l.ipConns[ip]++
	return true
}

// RemoveIP decrements the connection count for the given IP.
func (l *Limits) RemoveIP(ip string) {
	l.mu.Lock()
	defer l.mu.Unlock()

	l.ipConns[ip]--
	if l.ipConns[ip] <= 0 {
		delete(l.ipConns, ip)
	}
}
