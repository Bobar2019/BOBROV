// ============================================================================
// BOB-ROV · Firmware ESP32-S3 — Configuration matérielle (GPIO / I2C)
// Centralise TOUS les brochages : aucune broche ne doit être codée en dur
// ailleurs dans le firmware.
// ============================================================================
#ifndef CONFIG_PINS_H
#define CONFIG_PINS_H

// --- Bus I2C principal (capteurs d'attitude) ---
#define PIN_I2C_SDA 8
#define PIN_I2C_SCL 9

// Fréquence du bus : 400 kHz (Fast Mode), supportée par les 3 capteurs
#define I2C_FREQ_HZ 400000UL

// --- Adresses I2C par défaut des centrales inertielles supportées ---
#define ADDR_QMI8658  0x6B
#define ADDR_ADXL345  0x53
#define ADDR_MPU6050  0x68

#endif // CONFIG_PINS_H
