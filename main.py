#!/usr/bin/env python3
"""
Cockpit-Lite ROV — Point d'entrée principal
Système de contrôle embarqué pour ROV sur Raspberry Pi 5

Usage:
    python main.py                           # Démarrage standard (port 8080, simulation)
    python main.py --port 9000               # Port personnalisé
    python main.py --no-sim                  # Mode capteurs réels
    python main.py --config /path/config.txt # Configuration personnalisée
    python main.py --host 127.0.0.1          # Écoute locale uniquement
"""

import sys
import os
import logging
import argparse
import signal
from pathlib import Path

# Ajouter le répertoire projet au path Python
PROJECT_ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, PROJECT_ROOT)

# Référence globale au serveur pour un arrêt propre
_server_instance = None


def signal_handler(sig, frame):
    """Gestionnaire de signaux pour arrêt propre (SIGTERM depuis systemd, SIGINT depuis Ctrl+C)"""
    sig_name = signal.Signals(sig).name
    logger = logging.getLogger('main')
    logger.info(f"Signal {sig_name} reçu — arrêt propre en cours...")
    if _server_instance is not None:
        try:
            _server_instance.scenario_manager.stop()
            _server_instance.video_streamer.stop()
            _server_instance.sensor_manager.stop()
            logger.info("Modules arrêtés proprement")
        except Exception as e:
            logger.warning(f"Erreur lors de l'arrêt des modules: {e}")
    sys.exit(0)


def setup_logging(level: str = "INFO", log_file: str = "logs/rov.log"):
    """
    Configure le système de logging avec sortie console + fichier.
    Crée le dossier logs/ si nécessaire.
    """
    # Créer le dossier de logs
    log_dir = os.path.dirname(log_file)
    if log_dir:
        os.makedirs(log_dir, exist_ok=True)

    numeric_level = getattr(logging, level.upper(), logging.INFO)

    # Format des logs
    fmt = '%(asctime)s [%(name)-20s] %(levelname)-7s %(message)s'
    date_fmt = '%Y-%m-%d %H:%M:%S'

    # Handlers : console + fichier
    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setLevel(numeric_level)
    console_handler.setFormatter(logging.Formatter(fmt, datefmt=date_fmt))

    file_handler = logging.FileHandler(log_file, mode='a', encoding='utf-8')
    file_handler.setLevel(logging.DEBUG)  # Fichier = tout logger
    file_handler.setFormatter(logging.Formatter(fmt, datefmt=date_fmt))

    # Configurer le root logger
    root_logger = logging.getLogger()
    root_logger.setLevel(logging.DEBUG)
    root_logger.addHandler(console_handler)
    root_logger.addHandler(file_handler)


def parse_args() -> argparse.Namespace:
    """Parse les arguments de la ligne de commande"""
    parser = argparse.ArgumentParser(
        description='Cockpit-Lite ROV — Interface de pilotage pour sous-marin téléguidé',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Exemples:
  python main.py                        Démarrage par défaut
  python main.py --port 9000            Port personnalisé
  python main.py --no-sim               Capteurs réels (I2C)
  python main.py --config my.conf       Config personnalisée
  python main.py -v                     Mode debug (verbose)
        """
    )

    parser.add_argument(
        '--host', type=str, default='0.0.0.0',
        help='Adresse d\'écoute du serveur (défaut: 0.0.0.0)'
    )
    parser.add_argument(
        '--port', type=int, default=None,
        help='Port du serveur web (défaut: depuis config.txt ou 8080)'
    )
    parser.add_argument(
        '--config', type=str, default='config.txt',
        help='Chemin vers le fichier de configuration (défaut: config.txt)'
    )
    parser.add_argument(
        '--log-level', type=str, default=None,
        choices=['DEBUG', 'INFO', 'WARNING', 'ERROR'],
        help='Niveau de logging (défaut: depuis config.txt ou INFO)'
    )
    parser.add_argument(
        '--no-sim', action='store_true',
        help='Désactiver le mode simulation (utiliser les vrais capteurs)'
    )
    parser.add_argument(
        '-v', '--verbose', action='store_true',
        help='Activer le mode debug (équivalent à --log-level DEBUG)'
    )

    return parser.parse_args()


def main():
    """Point d'entrée principal de l'application"""
    args = parse_args()

    # Changer vers le répertoire du projet pour les chemins relatifs
    os.chdir(PROJECT_ROOT)

    # Déterminer le niveau de log
    log_level = 'DEBUG' if args.verbose else (args.log_level or 'INFO')

    # Configurer le logging
    setup_logging(log_level)
    logger = logging.getLogger('main')

    # Bannière de démarrage
    logger.info("=" * 55)
    logger.info("   Cockpit-Lite ROV v1.0.0")
    logger.info("   Système de contrôle embarqué — Raspberry Pi 5")
    logger.info("=" * 55)

    # Vérifier le fichier de configuration
    config_path = args.config
    if not os.path.isabs(config_path):
        config_path = os.path.join(PROJECT_ROOT, config_path)

    if not os.path.exists(config_path):
        logger.warning(f"Fichier de configuration non trouvé: {config_path}")
        logger.info("Un fichier par défaut sera créé automatiquement.")

    # Importer après logging setup
    from backend.config_parser import ConfigParser
    from backend.server import WebServer

    # Enregistrer les gestionnaires de signaux
    signal.signal(signal.SIGTERM, signal_handler)
    signal.signal(signal.SIGINT, signal_handler)

    try:
        # Charger la configuration
        config = ConfigParser(config_path)

        # Déterminer le port (CLI > config > défaut)
        port = args.port or config.get('SERVER', 'port', 8080)
        host = args.host

        # Niveau de log depuis config si pas spécifié en CLI
        if not args.log_level and not args.verbose:
            cfg_level = config.get('SERVER', 'log_level', 'INFO')
            if isinstance(cfg_level, str):
                log_level = cfg_level.upper()

        # Afficher les paramètres
        logger.info(f"  Hôte       : {host}")
        logger.info(f"  Port       : {port}")
        logger.info(f"  Config     : {config_path}")
        logger.info(f"  Log level  : {log_level}")
        logger.info(f"  Simulation : {'Oui' if not args.no_sim else 'Non (capteurs réels)'}")
        logger.info(f"  URL        : http://{host}:{port}")
        logger.info("-" * 55)

        # Créer le serveur
        server = WebServer(config_path)
        global _server_instance
        _server_instance = server

        # Appliquer le mode simulation depuis les args CLI
        if args.no_sim:
            server.sensor_manager.set_simulation(False)
            logger.info("Mode capteurs RÉELS activé (I2C/UART)")

        # Lancer le serveur
        server.run(host=host, port=port)

    except KeyboardInterrupt:
        logger.info("\nArrêt demandé par l'utilisateur (Ctrl+C)")
    except ImportError as e:
        logger.error(f"Module manquant: {e}")
        logger.error("Installez les dépendances: pip install -r requirements.txt")
        sys.exit(1)
    except Exception as e:
        logger.error(f"Erreur fatale: {e}", exc_info=True)
        sys.exit(1)
    finally:
        logger.info("Application terminée.")


if __name__ == "__main__":
    main()
