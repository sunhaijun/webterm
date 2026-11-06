package agent

// ServeAttachAs opens an attach socket that accepts only peers running as uid,
// so a test can see its own connections refused.
func (a *Agent) ServeAttachAs(path string, uid uint32) (*AttachServer, error) {
	return a.serveAttach(path, uid)
}
