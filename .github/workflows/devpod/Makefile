.DEFAULT_GOAL := help
CONTAINER_ENGINE ?= podman
DEVPOD_IMAGE ?= localhost/kyuby-devpod
export CONTAINER_ENGINE DEVPOD_IMAGE CONFIRM CLEAN_WORKERS STALE_DAYS
.PHONY: help image dev gates check test test-browser build dry-run export-public deploy-preview deploy-prod prod-check ship clean cloudflare-clean mint-keys-renew

help:
	@echo "DevPod: image dev gates check test test-browser build dry-run export-public deploy-preview deploy-prod prod-check clean cloudflare-clean mint-keys-renew"

ifeq ($(KYUBY_DEVPOD),1)
dev:
	npm run dev -- --host 0.0.0.0
check:
	npm run check
test:
	npx --no-install vitest run
test-browser:
	npx --no-install playwright test --output=test-results/playwright
build:
	npm run build
dry-run:
	npm run deploy:dry-run
gates:
	bash /opt/kyuby-devpod/gates.sh
else
image dev gates check test test-browser build dry-run deploy-preview clean:
	@node .github/workflows/devpod/invoke.mjs $@
# DevPod provides the validated Node 22.x environment; host export only stages/scans/publishes.
export-public: gates
	@node .github/workflows/devpod/host.mjs export-public
deploy-prod ship:
	@node .github/workflows/devpod/host.mjs deploy-prod
prod-check:
	@node .github/workflows/devpod/host.mjs prod-check
cloudflare-clean:
	@node .github/workflows/devpod/cloudflare-clean.mjs
mint-keys-renew:
	@node .github/workflows/devpod/host.mjs mint-keys-renew
endif
