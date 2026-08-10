// ============================================================================
// BOB-ROV · HAL IMU — Driver MPU6050 (implémentation)
// ============================================================================
#include "DriverMPU6050.h"
#include "I2CRegs.h"

using namespace I2CRegs;

bool DriverMPU6050::begin() {
    // Identification (les 7 bits de poids fort du WHO_AM_I)
    if ((read8(_addr, REG_WHO_AM_I) & 0x7E) != (WHO_AM_I_VAL & 0x7E)) return false;

    // Reset complet puis sortie de veille, horloge sur PLL gyro X (plus stable)
    write8(_addr, REG_PWR_MGMT_1, 0x80);
    delay(100);
    if (!write8(_addr, REG_PWR_MGMT_1, 0x01)) return false;
    delay(10);

    // DLPF 44 Hz (accel) / 42 Hz (gyro) : anti-vibration moteurs intégré
    if (!write8(_addr, REG_CONFIG, 0x03)) return false;
    // Cadence 1 kHz / (1 + 1) = 500 Hz
    if (!write8(_addr, REG_SMPLRT_DIV, 0x01)) return false;
    // Gyro ±500 °/s
    if (!write8(_addr, REG_GYRO_CONFIG, 0x08)) return false;
    // Accel ±8 g
    if (!write8(_addr, REG_ACCEL_CONFIG, 0x10)) return false;
    delay(50);   // stabilisation

    // Dérive gyro estimée à l'init (capteur immobile au boot), pose de départ
    estimateGyroBias();
    seedAnglesFromAccel();
    return true;
}

bool DriverMPU6050::readRaw(float& ax, float& ay, float& az,
                            float& gx, float& gy, float& gz) {
    uint8_t b[14];   // AX AY AZ | TEMP | GX GY GZ (big-endian)
    if (!readBytes(_addr, REG_ACCEL_XOUT_H, b, sizeof(b))) return false;
    ax = (int16_t)((b[0]  << 8) | b[1])  / ACC_LSB_PER_G;
    ay = (int16_t)((b[2]  << 8) | b[3])  / ACC_LSB_PER_G;
    az = (int16_t)((b[4]  << 8) | b[5])  / ACC_LSB_PER_G;
    // b[6..7] = température (ignorée)
    gx = (int16_t)((b[8]  << 8) | b[9])  / GYR_LSB_PER_DPS;
    gy = (int16_t)((b[10] << 8) | b[11]) / GYR_LSB_PER_DPS;
    gz = (int16_t)((b[12] << 8) | b[13]) / GYR_LSB_PER_DPS;
    return true;
}
