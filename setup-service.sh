#!/bin/bash
# ============================================================
# BOB-ROV — Script d'installation du service systemd
# Usage: sudo bash setup-service.sh
# ============================================================

set -e

# Variables
PROJECT_DIR="/home/bob/cockpit-lite-rov"
SERVICE_NAME="bob-rov"
SERVICE_FILE="${PROJECT_DIR}/bob-rov.service"
SYSTEMD_DIR="/etc/systemd/system"
LOG_DIR="${PROJECT_DIR}/logs"
VENV_PYTHON="${PROJECT_DIR}/venv/bin/python"

# Couleurs
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo ""
echo "=========================================="
echo "  BOB-ROV — Installation du service systemd"
echo "=========================================="
echo ""

# Vérifier les droits root
if [ "$EUID" -ne 0 ]; then
    echo -e "${RED}[ERREUR] Ce script doit être exécuté en tant que root (sudo)${NC}"
    exit 1
fi

# Vérifier que le projet existe
if [ ! -d "$PROJECT_DIR" ]; then
    echo -e "${RED}[ERREUR] Dossier projet introuvable: ${PROJECT_DIR}${NC}"
    exit 1
fi
echo -e "${GREEN}[✓] Projet trouvé: ${PROJECT_DIR}${NC}"

# Vérifier le fichier service
if [ ! -f "$SERVICE_FILE" ]; then
    echo -e "${RED}[ERREUR] Fichier service introuvable: ${SERVICE_FILE}${NC}"
    exit 1
fi
echo -e "${GREEN}[✓] Fichier service trouvé${NC}"

# Vérifier l'environnement virtuel
if [ ! -f "$VENV_PYTHON" ]; then
    echo -e "${RED}[ERREUR] Environnement virtuel introuvable: ${VENV_PYTHON}${NC}"
    echo -e "${YELLOW}  Créez-le avec: python3 -m venv ${PROJECT_DIR}/venv${NC}"
    exit 1
fi
echo -e "${GREEN}[✓] Environnement virtuel trouvé${NC}"

# Vérifier main.py
if [ ! -f "${PROJECT_DIR}/main.py" ]; then
    echo -e "${RED}[ERREUR] main.py introuvable${NC}"
    exit 1
fi
echo -e "${GREEN}[✓] main.py trouvé${NC}"

# Créer le dossier logs
mkdir -p "$LOG_DIR"
chown bob:bob "$LOG_DIR"
echo -e "${GREEN}[✓] Dossier logs créé: ${LOG_DIR}${NC}"

# Arrêter le service s'il tourne déjà
if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
    echo -e "${YELLOW}[...] Arrêt du service existant...${NC}"
    systemctl stop "$SERVICE_NAME"
fi

# Copier le fichier service vers systemd
cp "$SERVICE_FILE" "${SYSTEMD_DIR}/${SERVICE_NAME}.service"
chmod 644 "${SYSTEMD_DIR}/${SERVICE_NAME}.service"
echo -e "${GREEN}[✓] Service copié vers ${SYSTEMD_DIR}/${NC}"

# Recharger systemd
systemctl daemon-reload
echo -e "${GREEN}[✓] systemd rechargé${NC}"

# Activer au démarrage
systemctl enable "$SERVICE_NAME"
echo -e "${GREEN}[✓] Service activé au boot${NC}"

# Vérifier l'activation
ENABLED=$(systemctl is-enabled "$SERVICE_NAME" 2>/dev/null || true)
if [ "$ENABLED" = "enabled" ]; then
    echo -e "${GREEN}[✓] Confirmation: service activé (enabled)${NC}"
else
    echo -e "${YELLOW}[!] État d'activation: ${ENABLED}${NC}"
fi

# Démarrer le service
echo -e "${YELLOW}[...] Démarrage du service...${NC}"
systemctl start "$SERVICE_NAME"
sleep 3

# Vérifier l'état
if systemctl is-active --quiet "$SERVICE_NAME"; then
    echo -e "${GREEN}[✓] Service démarré avec succès !${NC}"
    echo ""
    systemctl status "$SERVICE_NAME" --no-pager -l
else
    echo -e "${RED}[!] Le service n'a pas démarré correctement${NC}"
    echo "  Vérifiez avec: sudo systemctl status ${SERVICE_NAME}"
    echo "  Logs: journalctl -u ${SERVICE_NAME} -n 20"
fi

echo ""
echo "=========================================="
echo "  Commandes utiles :"
echo "=========================================="
echo ""
echo "  sudo systemctl status ${SERVICE_NAME}    → Vérifier l'état"
echo "  sudo systemctl start ${SERVICE_NAME}     → Démarrer"
echo "  sudo systemctl stop ${SERVICE_NAME}      → Arrêter"
echo "  sudo systemctl restart ${SERVICE_NAME}   → Redémarrer"
echo "  journalctl -u ${SERVICE_NAME} -f         → Logs en temps réel"
echo "  tail -f ${LOG_DIR}/rov.log               → Logs applicatifs"
echo ""
echo "  sudo systemctl disable ${SERVICE_NAME}   → Désactiver au boot"
echo ""
