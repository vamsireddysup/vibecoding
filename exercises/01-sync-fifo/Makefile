RTL := rtl/sync_fifo.v
WAVES := sim_build/sync_fifo.fst

.PHONY: test lint waves clean

test:
	python3 tb/run.py

lint:
	verilator --lint-only -Wall $(RTL)

waves: $(WAVES)
	gtkwave $(WAVES)

clean:
	rm -rf sim_build __pycache__ tb/__pycache__ results.xml
