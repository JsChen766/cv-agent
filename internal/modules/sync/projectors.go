package sync

import "fmt"

type projectorRegistry struct {
	ordered []Projector
	byType  map[EntityType]Projector
}

func newProjectorRegistry(projectors []Projector) (projectorRegistry, error) {
	registry := projectorRegistry{
		ordered: append([]Projector(nil), projectors...),
		byType:  make(map[EntityType]Projector, len(projectors)),
	}
	for _, projector := range projectors {
		entityType := projector.EntityType()
		if _, exists := registry.byType[entityType]; exists {
			return projectorRegistry{}, fmt.Errorf("duplicate sync projector: %s", entityType)
		}
		registry.byType[entityType] = projector
	}
	return registry, nil
}

func (r projectorRegistry) get(entityType EntityType) (Projector, bool) {
	projector, ok := r.byType[entityType]
	return projector, ok
}
