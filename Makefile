EXERCISES := $(wildcard exercises/*/)

.PHONY: test lint regress index clean help

help:
	@echo "make lint     Verilator -Wall over every exercise"
	@echo "make test     run every exercise's cocotb suite"
	@echo "make regress  same as test, with a summary table"
	@echo "make index    regenerate logs/INDEX.md from the per-exercise logs"
	@echo "make clean    remove simulation build output"

test: regress

regress:
	python3 tools/run_regression.py

lint:
	@for d in $(EXERCISES); do \
		echo "linting $$d"; \
		$(MAKE) -C $$d lint || exit 1; \
	done

index:
	python3 tools/index_logs.py

clean:
	@for d in $(EXERCISES); do $(MAKE) -C $$d clean; done
