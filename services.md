/etc/systemd/system/stt.service

[Unit]
Description=Whisper STT (WS) On-Prem
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=asterisk
Group=asterisk
WorkingDirectory=/opt/asterisk-stt/stt
Environment=LANG=es
Environment=MODEL_SIZE=small
Environment=DEVICE=cpu
Environment=COMPUTE_TYPE=int8
Environment=RELAY_URL=http://127.0.0.1:7070/event
ExecStart=/opt/asterisk-stt/venv/bin/python /opt/asterisk-stt/stt/server.py
Restart=always
RestartSec=1

[Install]
WantedBy=multi-user.target



/etc/systemd/system/rtp2ws.service

[Unit]
Description=RTP L16 → WS (mix/agent/customer)
After=stt.service
Requires=stt.service

[Service]
Type=simple
User=asterisk
Group=asterisk
WorkingDirectory=/opt/asterisk-stt/rtp2ws
Environment=CALL_ID=live
ExecStart=/usr/bin/node /opt/asterisk-stt/rtp2ws/rtp2ws.js
Restart=always
RestartSec=1

[Install]
WantedBy=multi-user.target





sudo systemctl daemon-reload
sudo systemctl enable --now stt.service rtp2ws.service
systemctl status stt.service rtp2ws.service
