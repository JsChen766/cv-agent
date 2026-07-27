package domain

// terminal reports whether a status is a terminal tracker state.
func (s Status) terminal() bool {
	switch s {
	case StatusOffer, StatusRejected, StatusNoResponse:
		return true
	default:
		return false
	}
}

// allowedTransitions maps each status to the statuses it may move to.
var allowedTransitions = map[Status][]Status{
	StatusApplied:      {StatusScreening, StatusRejected, StatusNoResponse},
	StatusScreening:    {StatusInterviewing, StatusRejected, StatusNoResponse},
	StatusInterviewing: {StatusInterviewing, StatusOffer, StatusRejected, StatusNoResponse},
	StatusOffer:        {},
	StatusRejected:     {},
	StatusNoResponse:   {},
}

// CanTransition reports whether moving from -> to is a legal tracker edge.
func CanTransition(from, to Status) bool {
	if !validStatus(from) || !validStatus(to) {
		return false
	}
	for _, candidate := range allowedTransitions[from] {
		if candidate == to {
			return true
		}
	}
	return false
}

func validStatus(s Status) bool {
	switch s {
	case StatusApplied, StatusScreening, StatusInterviewing,
		StatusOffer, StatusRejected, StatusNoResponse:
		return true
	default:
		return false
	}
}

func validDeliveryMethod(m DeliveryMethod) bool {
	switch m {
	case DeliveryFormFill, DeliveryEmailFill, DeliveryManual, DeliveryOther:
		return true
	default:
		return false
	}
}

func validSource(s Source) bool {
	switch s {
	case SourceManual, SourceBrowser, SourceEmail, SourceOther:
		return true
	default:
		return false
	}
}
