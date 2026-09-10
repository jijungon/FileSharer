# FileSharer 표준 명령 — 로컬과 CI가 같은 명령을 쓴다 (워크플로우 문서 참고)
VENV := backend/.venv
PY := $(VENV)/bin/python

.PHONY: bootstrap venv web-deps dev dev-api dev-web test lint e2e prod-check clean

bootstrap: venv web-deps ## 최초 1회: venv + node_modules 설치
	@echo "bootstrap done"

venv:
	@test -d $(VENV) || python3 -m venv $(VENV)
	@$(VENV)/bin/pip install -q -e "backend/.[dev]" 2>/dev/null || (cd backend && ../$(PY) -m pip install -q -e ".[dev]")

web-deps:
	@test -d frontend/node_modules || (cd frontend && npm install)

dev: ## 로컬 개발 서버 (도커 없음): uvicorn --reload(8642) + vite dev(5173)
	@trap 'kill 0' INT; \
	backend/.venv/bin/uvicorn app.main:app --app-dir backend --reload --reload-dir backend --port 8642 & \
	(cd frontend && npm run dev) & \
	wait

test: ## 백엔드 테스트 (CI의 backend job과 동일)
	cd backend && .venv/bin/ruff check . && .venv/bin/pytest -q

lint: ## 전체 lint (백엔드 ruff + 프론트 eslint)
	cd backend && .venv/bin/ruff check .
	cd frontend && npm run lint

e2e: ## 떠 있는 서버(BASE_URL, 기본 http://localhost:8484) 대상 Playwright
	cd e2e && npm install && npx playwright test

prod-check: ## prod 이미지 빌드 + compose 기동 스모크 (PR 올리기 전)
	docker compose up -d --build
	@sleep 3
	@curl -fsS http://localhost:8484/api/health && echo " <- health OK"
	docker compose down

clean:
	rm -rf $(VENV) frontend/node_modules frontend/dist e2e/node_modules
