package domain

import "time"

const (
	monthLayout = "2006-01"
	dateLayout  = "2006-01-02"
)

type dateInterval struct {
	first   time.Time
	last    time.Time
	present bool
	set     bool
}

func validExperienceDates(start, end *string) bool {
	startRange, ok := parseExperienceDate(start, false)
	if !ok {
		return false
	}
	endRange, ok := parseExperienceDate(end, true)
	if !ok {
		return false
	}
	if !startRange.set || !endRange.set || endRange.present {
		return true
	}
	return !endRange.last.Before(startRange.first)
}

func parseExperienceDate(value *string, allowPresent bool) (dateInterval, bool) {
	if value == nil || *value == "" {
		return dateInterval{}, true
	}
	if *value == "present" {
		return dateInterval{present: true, set: true}, allowPresent
	}
	if len(*value) == len(monthLayout) {
		first, err := time.Parse(monthLayout, *value)
		if err != nil {
			return dateInterval{}, false
		}
		last := first.AddDate(0, 1, 0).Add(-24 * time.Hour)
		return dateInterval{first: first, last: last, set: true}, true
	}
	parsed, err := time.Parse(dateLayout, *value)
	if err != nil {
		return dateInterval{}, false
	}
	return dateInterval{first: parsed, last: parsed, set: true}, true
}
