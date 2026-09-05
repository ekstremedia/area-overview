# Docker Compose operations for area-overview -- mirrors the target names
# used by the other projects on this box (see ~/projects/huskeapp/Makefile)
# so the muscle memory carries over. This project has no separate dev
# stack: `npm run dev` (native, no Docker) is the dev workflow; every
# target here is production packaging.

.PHONY: init build up down restart deploy logs shell check

init: ## Create .env from .env.example if it doesn't already exist yet
	@if [ -f .env ]; then \
		echo "  .env already exists -- not touching it"; \
	else \
		cp .env.example .env; \
		echo "  created .env from .env.example"; \
	fi
	@echo ""
	@echo "  Fill these in before starting the stack (never printed here):"
	@echo "    SETTINGS_PASSWORD          (required, >= 16 characters)"
	@echo "    BARENTSWATCH_CLIENT_ID"
	@echo "    BARENTSWATCH_CLIENT_SECRET"
	@echo ""

build: ## Build the image
	docker compose build

up: ## Start the stack
	docker compose up -d

down: ## Stop the stack
	docker compose down

restart: ## Restart the app container
	docker compose restart

deploy: ## Pull the newest code, rebuild, and bring the stack up
	git pull --ff-only
	docker compose up -d --build
	docker compose ps

logs: ## Follow the app container's logs
	docker compose logs -f app

shell: ## Open a shell in the app container (alpine: sh, not bash)
	docker compose exec app sh

check: ## Verify the app is loopback-only and healthy
	@echo "  → checking the published port is loopback-only"
	@if ss -ltnp 2>/dev/null | grep -q '8141'; then \
		if ss -ltnp 2>/dev/null | grep '8141' | grep -qE '127\.0\.0\.1:8141'; then \
			echo "  ✓ 127.0.0.1:8141 (loopback only)"; \
		else \
			echo "  ✗ port 8141 is NOT bound to 127.0.0.1 only:"; \
			ss -ltnp 2>/dev/null | grep '8141'; \
			exit 1; \
		fi; \
	else \
		echo "  ✗ nothing is listening on 8141 -- is the stack up? (make up)"; \
		exit 1; \
	fi
	@echo "  → checking /healthz"
	@curl -fsS http://127.0.0.1:8141/healthz && echo "" && echo "  ✓ healthz OK"
