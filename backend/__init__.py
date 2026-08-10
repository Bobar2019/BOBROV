"""
Cockpit-Lite ROV - Backend Package
Système de contrôle embarqué pour Raspberry Pi 5

Note: Les imports sont faits de manière paresseuse dans server.py
pour éviter de bloquer le démarrage si un module (ex: cv2) n'est pas installé.
"""

__version__ = "1.0.0"
__author__ = "Didier Dero"

# Pas d'import direct ici — chaque module est importé par server.py
# quand il est réellement nécessaire. Cela évite les crashs au démarrage
# si une dépendance optionnelle (cv2, smbus2) manque.
