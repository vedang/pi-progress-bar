SHELL := /bin/bash
.SHELLFLAGS := -Eeuo pipefail -c

.DEFAULT_GOAL := help

BIOME_SCOPE ?= package.json biome.json knip.json tsconfig.json $(wildcard vitest.config.*.ts) $(wildcard src) $(wildcard __tests__)

.PHONY: help
help: ## Show available targets
	@awk '/^[a-zA-Z0-9_-]+:.*##/ { \
		printf "%-25s # %s\n", \
		substr($$1, 1, length($$1) - 1), \
		substr($$0, index($$0, "##") + 3) \
	}' $(MAKEFILE_LIST)

.PHONY: format
format: ## Format project files with Biome
	./node_modules/.bin/biome check --write $(BIOME_SCOPE)

.PHONY: check-biome
check-biome:
	./node_modules/.bin/biome check $(BIOME_SCOPE)

.PHONY: check-typescript
check-typescript:
	./node_modules/.bin/tsc --noEmit -p tsconfig.json

.PHONY: check-knip
check-knip:
	./node_modules/.bin/knip

.PHONY: check
check: check-biome check-typescript check-knip ## Run formatting, TypeScript, and Knip checks

.PHONY: test-unit
test-unit:
	./node_modules/.bin/vitest run --config vitest.config.unit.ts

.PHONY: test-integration
test-integration:
	./node_modules/.bin/vitest run --config vitest.config.integration.ts

.PHONY: test-live
test-live: ## Paid hybrid replay (explicit group, revision, artifact dir and provider credentials required)
	./node_modules/.bin/vitest run --config vitest.config.live.ts

.PHONY: test
test: test-unit ## Run deterministic unit then integration suites
	@$(MAKE) test-integration
