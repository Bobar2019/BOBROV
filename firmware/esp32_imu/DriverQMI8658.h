// ============================================================================
// BOB-ROV · HAL IMU — Driver QMI8658 (QST, 6 axes Accel + Gyro, I2C 0x6B)
// Accès direct aux registres (aucune librairie externe requise).
// Fusion Roll/Pitch/Yaw héritée de IMU6AxisFusion (filtre complémentaire
// + correction de dérive gyro).
// ============================================================================
#ifndef DRIVER_QMI8658_H
#define DRIVER_QMI8658_H

#include "IMU6AxisFusion.h"

class DriverQMI8658 : public IMU6AxisFusion {
public:
    explicit DriverQMI8658(uint8_t addr) : _addr(addr) {}

    bool begin() override;
    const char* name() const override { return "QMI8658"; }

protected:
    bool readRaw(float& ax, float& ay, float& az,
                 float& gx, float& gy, float& gz) override;

private:
    uint8_t _addr;

    // --- Registres QMI8658 ---
    static constexpr uint8_t REG_WHO_AM_I  = 0x00;   // doit répondre 0x05
    static constexpr uint8_t REG_CTRL1     = 0x02;   // config bus / endianness
    static constexpr uint8_t REG_CTRL2     = 0x03;   // accéléromètre (échelle + ODR)
    static constexpr uint8_t REG_CTRL3     = 0x04;   // gyroscope (échelle + ODR)
    static constexpr uint8_t REG_CTRL7     = 0x08;   // enable accel + gyro
    static constexpr uint8_t REG_RESET     = 0x60;   // soft reset (écrire 0xB0)
    static constexpr uint8_t REG_AX_L      = 0x35;   // début du bloc AX..GZ (12 octets)
    static constexpr uint8_t WHO_AM_I_VAL  = 0x05;

    // Sensibilités pour ±8 g et ±512 °/s (LSB par unité physique)
    static constexpr float ACC_LSB_PER_G   = 4096.0f;
    static constexpr float GYR_LSB_PER_DPS = 64.0f;
};

#endif // DRIVER_QMI8658_H
