# Thin wrapper over install.sh and the npm scripts; the real logic lives there.
# Needs Node >= 24 on PATH for everything except install/check/uninstall.

SERVICE := motherapp
URL     := http://127.0.0.1:$(or $(MOTHERAPP_PORT),7323)/

.DEFAULT_GOAL := help
.PHONY: help install check doctor uninstall purge deps build test typecheck verify \
        dev start status restart stop logs open clean

help: ## List targets
	@awk 'BEGIN {FS = ":.*## "} /^[a-z-]+:.*## / {printf "  \033[1m%-10s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

# --- install (install.sh) ---------------------------------------------------

install: ## Check deps, install missing ones (asks first), build, set up the service
	./install.sh

check: ## Report dependency and service status, change nothing
	./install.sh --check

doctor: check ## Same as check

uninstall: ## Stop and remove the service, keep config and state
	./install.sh --uninstall

purge: ## Remove the service and also config and state
	./install.sh --uninstall --purge

# --- develop (npm scripts) --------------------------------------------------

deps: ## Install npm dependencies from the lockfile
	npm ci

build: ## Build the web frontend
	npm run build

test: ## Run all tests
	npm test

typecheck: ## Type-check everything
	npm run typecheck

verify: typecheck test build ## Typecheck, test and build (run before pushing)

dev: ## Core plus Vite dev server
	npm run dev

start: build ## Run the core in the foreground
	npm start

# --- the running service ----------------------------------------------------

status: ## Show the systemd user service status
	systemctl --user status $(SERVICE) --no-pager

restart: ## Restart the service
	systemctl --user restart $(SERVICE)

stop: ## Stop the service
	systemctl --user stop $(SERVICE)

logs: ## Follow the service log
	journalctl --user -u $(SERVICE) -f -o cat

open: ## Open the UI in the default browser
	xdg-open $(URL)

clean: ## Remove build output
	rm -rf web/dist
