# activa el venv
source /opt/asterisk-stt/venv/bin/activate

# desactiva el mirror xethub
export HF_HUB_ENABLE_HF_TRANSFER=0

# asegúrate de tener una versión reciente del hub (la variable funciona a partir de ~0.23)
pip install -U "huggingface_hub>=0.24.0"

# (opcional) define un cache local
export HF_HOME=/opt/asterisk-stt/hf-cache
mkdir -p "$HF_HOME"

# verifica que la variable esté activa
python - <<'PY'
import os, huggingface_hub as hfh
print("hub:", hfh.__version__, "HF_HUB_ENABLE_HF_TRANSFER=", os.getenv("HF_HUB_ENABLE_HF_TRANSFER"))
PY

# reintenta la descarga programática
python - <<'PY'
from huggingface_hub import snapshot_download
dst="/opt/asterisk-stt/models/faster-whisper-small"
p=snapshot_download("Systran/faster-whisper-small", local_dir=dst)
print("Descargado en:", p)
PY

python3 - <<'PY'
from huggingface_hub import snapshot_download

dst = "/opt/asterisk-stt/models/faster-whisper-small"
p = snapshot_download("Systran/faster-whisper-small", local_dir=dst)

print("Descargado en:", p)
PY
