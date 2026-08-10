// ============================================================================
// BOB-ROV · Firmware ESP32-S3 DevKit — Télémétrie d'attitude (IMU)
// ----------------------------------------------------------------------------
// Couche d'abstraction matérielle (HAL) : la logique ci-dessous ne connaît
// QUE l'interface IMUBase. Le capteur réel (QMI8658 / MPU6050 / ADXL345) est
// auto-détecté sur le bus I2C au démarrage par IMUFactory ; sans capteur, un
// driver Dummy garantit un système qui ne plante jamais.
//
// Sortie : trame JSON sur le port série USB (115200 bauds), consommée par le
// backend du Cockpit qui la relaie en WebSocket vers l'IHM :
//   {"type":"imu","sensor":"QMI8658","roll":1.2,"pitch":-0.4,"yaw":12.8,"calibrated":true}
//
// Commandes reçues (UART/Serial, une par ligne — le backend peut les relayer
// depuis le WebSocket du Cockpit, ex. action gamepad "imu_tare") :
//   TARE  (ou CALIBRATE / ZERO) : recalibrage zéro à l'horizontale
//   INFO                        : renvoie le driver actif
// ============================================================================
#include "config_pins.h"
#include "IMUBase.h"
#include "IMUFactory.h"

// --- Cadences (ms) ---
static const uint32_t UPDATE_PERIOD_MS    = 5;    // fusion capteur à 200 Hz
static const uint32_t TELEMETRY_PERIOD_MS = 50;   // trame JSON à 20 Hz

// --- État global ---
IMUBase*  imu = nullptr;       // driver actif (jamais nullptr après setup)
IMUData_t imuData = { 0.0f, 0.0f, 0.0f, false };   // structure d'échange globale

static uint32_t lastUpdateMs = 0;
static uint32_t lastTelemetryMs = 0;

// ----------------------------------------------------------------------------
// Commandes série (une commande par ligne, insensible à la casse)
// ----------------------------------------------------------------------------
static void handleSerialCommands() {
    static String line;
    while (Serial.available()) {
        const char c = (char)Serial.read();
        if (c == '\n' || c == '\r') {
            line.trim();
            line.toUpperCase();
            if (line == "TARE" || line == "CALIBRATE" || line == "ZERO") {
                Serial.println("{\"type\":\"imu_cmd\",\"cmd\":\"tare\",\"status\":\"running\"}");
                imu->calibrateZero();   // bloquant ~0,5 s : ROV immobile requis
                imu->fillData(imuData);
                Serial.printf("{\"type\":\"imu_cmd\",\"cmd\":\"tare\",\"status\":\"%s\"}\n",
                              imuData.isCalibrated ? "done" : "unsupported");
            } else if (line == "INFO") {
                Serial.printf("{\"type\":\"imu_info\",\"sensor\":\"%s\",\"calibrated\":%s}\n",
                              imu->name(), imuData.isCalibrated ? "true" : "false");
            }
            line = "";
        } else if (line.length() < 32) {
            line += c;
        }
    }
}

// ----------------------------------------------------------------------------
// Télémétrie JSON (roll/pitch/yaw en degrés, 2 décimales)
// ----------------------------------------------------------------------------
static void sendTelemetry() {
    Serial.printf(
        "{\"type\":\"imu\",\"sensor\":\"%s\",\"roll\":%.2f,\"pitch\":%.2f,"
        "\"yaw\":%.2f,\"calibrated\":%s}\n",
        imu->name(), imuData.roll, imuData.pitch, imuData.yaw,
        imuData.isCalibrated ? "true" : "false");
}

// ----------------------------------------------------------------------------
void setup() {
    Serial.begin(115200);
    delay(300);   // laisse l'USB-CDC s'énumérer
    Serial.println("\n[BOB-ROV] Firmware IMU ESP32-S3 — démarrage");

    // Auto-détection : scan I2C + instanciation du bon driver (ou Dummy)
    imu = IMUFactory::createAutoDetected();

    // Tare initiale : le ROV est supposé posé à l'horizontale au boot
    imu->calibrateZero();
    imu->fillData(imuData);
    Serial.printf("[IMU] Prêt (driver %s, calibré: %s)\n",
                  imu->name(), imuData.isCalibrated ? "oui" : "non");
}

void loop() {
    const uint32_t now = millis();

    // Fusion capteur à cadence fixe (200 Hz)
    if (now - lastUpdateMs >= UPDATE_PERIOD_MS) {
        lastUpdateMs = now;
        imu->update();
        imu->fillData(imuData);
    }

    // Trame de télémétrie vers le Cockpit (20 Hz)
    if (now - lastTelemetryMs >= TELEMETRY_PERIOD_MS) {
        lastTelemetryMs = now;
        sendTelemetry();
    }

    // Ordres reçus du Cockpit (tare / info)
    handleSerialCommands();
}
