# Configuración de Asterisk para Coach de Llamadas

Este documento contiene la configuración necesaria para el sistema de coach de llamadas con Asterisk, incluyendo configuraciones de HTTP, ARI, PJSIP y extensiones.

## 1. Configuración HTTP (http.conf)

```ini
[general]
enabled=yes
bindaddr=0.0.0.0
bindport=8088
```

## 2. Configuración ARI (ari.conf)

```ini
[general]
enabled = yes
pretty = yes
allowed_origins = *

[coach]
type = user
read_only = no
password = verysecret
```

## 3. Configuración PJSIP (pjsip.conf)

### Configuración Global

```ini
; ================================
; Configuración global PJSIP
; ================================
[global]
type=global
user_agent=Asterisk-22
```

### Transporte UDP

```ini
; ================================
; Transporte UDP
; ================================
[transport-udp]
type=transport
protocol=udp
bind=0.0.0.0:5060
```

### Extensión 200

```ini
; ================================
; Extensión 200
; ================================
[200]
type=endpoint
transport=transport-udp
context=internal
disallow=all
allow=ulaw,alaw
auth=auth200
aors=200

[auth200]
type=auth
auth_type=userpass
username=200
password=200secret   ; <-- cambia por una contraseña segura

[200]
type=aor
max_contacts=2
```

### Extensión 201

```ini
; ================================
; Extensión 201
; ================================
[201]
type=endpoint
transport=transport-udp
context=internal
disallow=all
allow=ulaw,alaw
auth=auth201
aors=201

[auth201]
type=auth
auth_type=userpass
username=201
password=201secret   ; <-- cambia por una contraseña segura

[201]
type=aor
max_contacts=2
```

## 4. Configuración de Extensiones (extensions.conf)

### Configuración General

```ini
[general]
static=yes
writeprotect=no
clearglobalvars=no
```

### Contexto de Llamadas Entrantes

```ini
[entrantes]

exten => _X.,1,NoOp(INBOUND DID ${EXTEN} FROM ${CALLERID(num)})
 same => n,Answer()
 same => n,Set(CHANNEL(language)=es)
 ; Aviso legal de grabación (ajusta el audio)
 same => n,Playback(custom/aviso_grabacion)     ; "Esta llamada puede ser grabada..."
 ; Nombre de archivo para auditoría
 same => n,Set(FN=${UNIQUEID}-${CALLERID(num)}-${STRFTIME(${EPOCH},,%Y%m%d-%H%M%S)})
 ; Grabación estéreo (agente/cliente)
 same => n,MixMonitor(${CBASE}/${FN}.wav,bm)    ; b=background, m=stereo (dual-channel)
 ; Enviar a tu app ARI (rol=caller, dirección=inbound)
 same => n,Stasis(coach_app,role=caller,direction=inbound,fn=${FN})
 same => n,Hangup()
```

### Contexto Interno

```ini
[internal]

; llamadas internas
exten => _2XX,1,NoOp(Llamada a 200)
; same => n,Answer()
; same => n,Playback(please-try-call-later)
 same => n,Dial(PJSIP/${EXTEN},20)
; same => n,Voicemail(200@default,u)
 same => n,Hangup()


exten => _*1,1,NoOp(INBOUND DID ${EXTEN} FROM ${CALLERID(num)})
 same => n,Answer()
 same => n,Set(CHANNEL(language)=es)
 ; Aviso legal de grabación (ajusta el audio)
 same => n,Playback(custom/aviso_grabacion)     ; "Esta llamada puede ser grabada..."
 ; Nombre de archivo para auditoría
 same => n,Set(FN=${UNIQUEID}-${CALLERID(num)}-${STRFTIME(${EPOCH},,%Y%m%d-%H%M%S)})
 ; Grabación estéreo (agente/cliente)
 same => n,MixMonitor(${CBASE}/${FN}.wav,bm)    ; b=background, m=stereo (dual-channel)
 ; Enviar a tu app ARI (rol=caller, dirección=inbound)
; same => n,Set(__ROLE=inbound)
 same => n,Stasis(coach_app,inbound)

; same => n,Stasis(coach_app,role=caller,direction=inbound,fn=${FN})
 same => n,Hangup()
```

### Funciones de Control de Grabación

```ini
[__pause_recording]
exten => s,1,NoOp(Pause MixMonitor)
 same => n,StopMixMonitor()
 same => n,Return()

[__resume_recording]
exten => s,1,NoOp(Resume MixMonitor)
 same => n,Set(FN=${IF(${ISNULL(${FN})}?${UNIQUEID}:${FN})})
 same => n,MixMonitor(${CBASE}/${FN}.wav,bm)
 same => n,Return()
```

## Notas Importantes

- **Puerto ARI**: 8088 (configurado en http.conf)
- **Puerto SIP**: 5060 (configurado en pjsip.conf)
- **Grabación**: Se utiliza MixMonitor con grabación estéreo (bm) para separar agente y cliente
- **Aplicación ARI**: `coach_app` es la aplicación que maneja las llamadas
- **Seguridad**: Cambiar las contraseñas por defecto en las configuraciones de autenticación
