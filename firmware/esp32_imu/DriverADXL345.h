// ============================================================================
// BOB-ROV · HAL IMU — Driver ADXL345 (Analog Devices, 3 axes Accel, I2C 0x53)
// Roll et Pitch calculés uniquement depuis la gravité (atan2). L'ADXL345 est
// aveugle au lacet : getYaw() renvoie systématiquement 0.0f.
// Filtre passe-bas par MOYENNE GLISSANTE pour adoucir le bruit de vibration.
// ============================================================================
#ifndef DRIVER_ADXL345_H
#define DRIVER_ADXL345_H

#include "IMUBase.h"

class DriverADXL345 : public IMUBase {
public:
    explicit DriverADXL345(uint8_t addr) : _addr(addr) {}

    bool  begin() override;
    void  update() override;
    float getRoll() override  { return _roll  - _rollZero; }
    float getPitch() override { return _pitch - _pitchZero; }
    float getYaw() override   { return 0.0f; }   // pas de gyro : lacet non mesurable
    void  calibrateZero() override;
    const char* name() const override { return "ADXL345"; }

private:
    bool readAccel(float& ax, float& ay, float& az);

    uint8_t _addr;

    // --- Moyenne glissante (fenêtre circulaire) sur les 3 axes ---
    static constexpr uint8_t WINDOW = 16;   // ~0.16 s de lissage à 100 Hz
    float   _buf[3][WINDOW] = {};
    float   _sum[3] = { 0, 0, 0 };
    uint8_t _idx = 0;
    uint8_t _filled = 0;

    float _roll = 0, _pitch = 0;             // angles filtrés (°)
    float _rollZero = 0, _pitchZero = 0;     // offsets de tare (°)

    // --- Registres ADXL345 ---
    static constexpr uint8_t REG_DEVID      = 0x00;   // doit répondre 0xE5
    static constexpr uint8_t REG_BW_RATE    = 0x2C;   // cadence de sortie
    static constexpr uint8_t REG_POWER_CTL  = 0x2D;   // mode mesure
    static constexpr uint8_t REG_DATA_FORMAT = 0x31;  // échelle / résolution
    static constexpr uint8_t REG_DATAX0     = 0x32;   // bloc X0..Z1 (6 octets)
    static constexpr uint8_t DEVID_VAL      = 0xE5;

    // ±4 g en mode full resolution : 256 LSB/g constant
    static constexpr float ACC_LSB_PER_G = 256.0f;
};

#endif // DRIVER_ADXL345_H
