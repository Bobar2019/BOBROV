// ============================================================================
// BOB-ROV · HAL IMU — Driver QMI8658 (implémentation)
// ============================================================================
#include "DriverQMI8658.h"
#include "I2CRegs.h"

using namespace I2CRegs;

bool DriverQMI8658::begin() {
    // Identification du composant
    if (read8(_addr, REG_WHO_AM_I) != WHO_AM_I_VAL) return false;

    // Soft reset puis attente de la remise en route
    write8(_addr, REG_RESET, 0xB0);
    delay(15);

    // CTRL1 : auto-incrément d'adresse + little-endian (lecture bloc 12 octets)
    if (!write8(_addr, REG_CTRL1, 0x60)) return false;
    // CTRL2 : accéléromètre ±8 g, ODR 500 Hz
    if (!write8(_addr, REG_CTRL2, 0x24)) return false;
    // CTRL3 : gyroscope ±512 °/s, ODR 500 Hz
    if (!write8(_addr, REG_CTRL3, 0x54)) return false;
    // CTRL7 : activation simultanée accel + gyro
    if (!write8(_addr, REG_CTRL7, 0x03)) return false;
    delay(50);   // stabilisation des filtres internes

    // Dérive gyro estimée à l'init (capteur immobile au boot), pose de départ
    estimateGyroBias();
    seedAnglesFromAccel();
    return true;
}

bool DriverQMI8658::readRaw(float& ax, float& ay, float& az,
                            float& gx, float& gy, float& gz) {
    uint8_t b[12];
    if (!readBytes(_addr, REG_AX_L, b, sizeof(b))) return false;
    // Little-endian : AX, AY, AZ, GX, GY, GZ (int16 chacun)
    ax = (int16_t)(b[0]  | (b[1]  << 8)) / ACC_LSB_PER_G;
    ay = (int16_t)(b[2]  | (b[3]  << 8)) / ACC_LSB_PER_G;
    az = (int16_t)(b[4]  | (b[5]  << 8)) / ACC_LSB_PER_G;
    gx = (int16_t)(b[6]  | (b[7]  << 8)) / GYR_LSB_PER_DPS;
    gy = (int16_t)(b[8]  | (b[9]  << 8)) / GYR_LSB_PER_DPS;
    gz = (int16_t)(b[10] | (b[11] << 8)) / GYR_LSB_PER_DPS;
    return true;
}
