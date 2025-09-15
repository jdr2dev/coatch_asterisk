#!/usr/bin/env bash
set -e
cd /opt/coatch_asterisk
source venv/bin/activate
export MODEL_SIZE=small         # o medium si tienes GPU
export DEVICE=cpu              # cuda | cpu
export COMPUTE_TYPE=int8     # float16|int8_float16|int8
export ENDPOINT_MS=450
python /opt/coatch_asterisk/stt/server.py

