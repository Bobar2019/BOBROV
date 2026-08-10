// ============================================================================
// BOB-ROV · HAL IMU — Driver ADXL345 (implémentation)
// ============================================================================
#include "DriverADXL345.h"
#include "I2CRegs.h"

using namespace I2CRegs;

bool DriverADXL345::begin() {
    // Identification du composant
    if (read8(_addr, REG_DEVID) != DEVID_VAL) return false;

    // Cadence 100 Hz (bruit faible, largement suffisant pour l'attitude)
    if (!write8(_addr, REG_BW_RATE, 0x0A)) return false;
    // Full resolution, ±4 g
    if (!write8(_addr, REG_DATA_FORMAT, 0x09)) return false;
    // Mode mesure
    if (!write8(_addr, REG_POWER_CTL, 0x08)) return false;
    delay(20);

    // Pré-remplissage de la fenêtre de lissage (angles stables immédiatement)
    for (uint8_t i = 0; i < WINDOW; i++) { update(); delay(5); }
    return true;
}

bool DriverADXL345::readAccel(float& ax, float& ay, float& az) {
    uint8_t b[6];
    if (!readBytes(_addr, REG_DATAX0, b, sizeof(b))) return false;
    // Little-endian : X, Y, Z (int16 chacun)
    ax = (int16_t)(b[0] | (b[1] << 8)) / ACC_LSB_PER_G;
    ay = (int16_t)(b[2] | (b[3] << 8)) / ACC_LSB_PER_G;
    az = (int16_t)(b[4] | (b[5] << 8)) / ACC_LSB_PER_G;
    return true;
}

void DriverADXL345::update() {
    float a[3];
    if (!readAccel(a[0], a[1], a[2])) return;

    // Filtre passe-bas : moyenne glissante sur WINDOW échantillons par axe
    for (uint8_t i = 0; i < 3; i++) {
        _sum[i] -= _buf[i][_idx];
        _buf[i][_idx] = a[i];
        _sum[i] += a[i];
    }
    _idx = (_idx + 1) % WINDOW;
    if (_filled < WINDOW) _filled++;

    const float ax = _sum[0] / _filled;
    const float ay = _sum[1] / _filled;
    const float az = _sum[2] / _filled;

    // Angles depuis la gravité uniquement (atan2) — le yaw reste inaccessible
    _roll  = atan2f(ay, az) * RAD_TO_DEG;
    _pitch = atan2f(-ax, sqrtf(ay * ay + az * az)) * RAD_TO_DEG;
}

// Tare : la pose actuelle (filtrée) devient l'horizontale de référence
void DriverADXL345::calibrateZero() {
    // Fenêtre reconstituée sur la pose courante pour une tare nette
    for (uint8_t i = 0; i < WINDOW; i++) { update(); delay(5); }
    _rollZero  = _roll;
    _pitchZero = _pitch;
    _calibrated = true;
}
