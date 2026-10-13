# ============================================================================
#  Makefile（WSL / Linux；Windows 上请用 build.ps1）
#  用法：
#    make            # 编译 CLI 与测试
#    make test       # 跑自检
#    make run        # 在 EES439 上跑冒烟测试
#    make bench      # 环乘法微基准
# ============================================================================
CXX      ?= g++
CXXFLAGS ?= -O3 -std=c++17 -march=native -fopenmp -Wall -Wextra -Isrc
LDFLAGS  ?=

CORE     := $(wildcard src/core/*.cpp)
BIN      := bin/ntru_cli
TESTBIN  := bin/ntru_tests

.PHONY: all test run bench clean

all: $(BIN) $(TESTBIN)

$(BIN): $(CORE) src/cli/main.cpp
	@mkdir -p bin
	$(CXX) $(CXXFLAGS) -o $@ $^ $(LDFLAGS)

$(TESTBIN): $(CORE) tests/test_core.cpp
	@mkdir -p bin
	$(CXX) $(CXXFLAGS) -o $@ $^ $(LDFLAGS)

test: $(TESTBIN)
	./$(TESTBIN)

selftest: $(BIN)
	./$(BIN) selftest

run: $(BIN)
	./$(BIN) smoke EES439 3 2

bench: $(BIN)
	./$(BIN) bench EES1171 200

clean:
	rm -rf bin
