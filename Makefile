.PHONY: setup bootstrap up up-runtime-egress down logs migrate test lint format api-shell web-shell

setup:
	@if [ -f .env ]; then \
		if ! grep -q '^RUNTIME_GATEWAY_TOKEN=' .env; then \
			echo "RUNTIME_GATEWAY_TOKEN=$$(openssl rand -hex 32)" >> .env; \
			echo "Added a generated runtime gateway token to .env."; \
		fi; \
		if ! grep -q '^SANDBOX_SUPERVISOR_TOKEN=' .env; then \
			echo "SANDBOX_SUPERVISOR_TOKEN=$$(openssl rand -hex 32)" >> .env; \
			echo "Added a generated sandbox supervisor token to .env."; \
		fi; \
		if ! grep -q '^PROVIDERS_ENCRYPTION_KEY=' .env; then \
			echo "PROVIDERS_ENCRYPTION_KEY=$$(openssl rand -hex 32)" >> .env; \
			echo "Added a generated providers encryption key to .env."; \
		fi; \
		echo ".env already exists; existing values were left unchanged."; \
	else \
		cp .env.example .env; \
		sed -i "s/^LOCAL_ADMIN_TOKEN=.*/LOCAL_ADMIN_TOKEN=$$(openssl rand -hex 32)/" .env; \
		sed -i "s/^PROVIDER_GATEWAY_TOKEN=.*/PROVIDER_GATEWAY_TOKEN=$$(openssl rand -hex 32)/" .env; \
		sed -i "s/^RUNTIME_GATEWAY_TOKEN=.*/RUNTIME_GATEWAY_TOKEN=$$(openssl rand -hex 32)/" .env; \
		sed -i "s/^SANDBOX_SUPERVISOR_TOKEN=.*/SANDBOX_SUPERVISOR_TOKEN=$$(openssl rand -hex 32)/" .env; \
		sed -i "s/^PROVIDERS_ENCRYPTION_KEY=.*/PROVIDERS_ENCRYPTION_KEY=$$(openssl rand -hex 32)/" .env; \
		echo "Created .env with generated admin and gateway tokens."; \
	fi

bootstrap: setup
	docker compose build
	docker compose run --rm migrate

up: setup
	docker compose up --build

up-runtime-egress: setup
	docker compose -f compose.yaml -f compose.runtime-egress.yaml up --build

down:
	docker compose down

logs:
	docker compose logs -f api worker web

migrate:
	docker compose run --rm migrate

test:
	docker compose run --rm --no-deps provider-gateway npm test
	docker compose run --rm api python -m pytest
	docker compose run --rm web npm test -- --run

provider-status:
	docker compose exec provider-gateway codex --version
	docker compose exec provider-gateway claude --version

lint:
	docker compose run --rm api python -m ruff check .
	docker compose run --rm api python -m mypy mission_control
	docker compose run --rm web npm run lint
	docker compose run --rm web npm run typecheck

format:
	docker compose run --rm api ruff format .
	docker compose run --rm web npm run format

api-shell:
	docker compose exec api /bin/sh

web-shell:
	docker compose exec web /bin/sh
