package agent

import (
	"errors"
	"strings"
)

// IssueError is a failed certificate request, already explained for humans.
type IssueError struct {
	// Diagnosis says what went wrong and how to fix it.
	Diagnosis string
	// Unreachable means the CA couldn't connect to this machine to validate it:
	// a closed cloud firewall, NAT, or DNS pointing elsewhere. Only the user can
	// fix that, so a guided install waits and checks again (ADR-0046).
	Unreachable bool
	err         error
}

func (e *IssueError) Error() string { return e.Diagnosis }
func (e *IssueError) Unwrap() error { return e.err }

// IsUnreachable reports whether err is a certificate request that failed because
// the CA couldn't reach this machine.
func IsUnreachable(err error) bool {
	var ie *IssueError
	return errors.As(err, &ie) && ie.Unreachable
}

func newIssueError(err error, domain string) *IssueError {
	return &IssueError{
		Diagnosis:   strings.TrimSpace(describeACMEError(err, domain)),
		Unreachable: isValidationFailure(err),
		err:         err,
	}
}
