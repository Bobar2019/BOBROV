// ============================================================================
// BOB-ROV · HAL IMU — Driver MPU6050 (InvenSense, 6 axes Accel + Gyro, 0x68)
// Accès direct aux registres. La fusion Roll/Pitch/Yaw est fournie par
// IMU6AxisFusion (filtre complémentaire + correction de dérive gyro) : même
// résultat que le DMP sans dépendre du firmware propriétaire InvenSense.
// ============================================================================
#ifndef DRIVER_MPU6050_H
#define DRIVER_MPU6050_H

#include "IMU6AxisFusion.h"

class DriverMPU6050 : public IMU6AxisFusion {
public:
    explicit DriverMPU6050(uint8_t addr) : _addr(addr) {}

    bool begin() override;
    const char* name() const override { return "MPU6050"; }

protected:
    bool readRaw(float& ax, float& ay, float& az,
                 float& gx, float& gy, float& gz) override;

private:
    uint8_t _addr;

    // --- Registres MPU6050 ---
    static constexpr uint8_t REG_PWR_MGMT_1   = 0x6B;   // sortie de veille + horloge
    static constexpr uint8_t REG_SMPLRT_DIV   = 0x19;   // diviseur de cadence
    static constexpr uint8_t REG_CONFIG       = 0x1A;   // filtre passe-bas interne (DLPF)
    static constexpr uint8_t REG_GYRO_CONFIG  = 0x1B;   // échelle gyro
    static constexpr uint8_t REG_ACCEL_CONFIG = 0x1C;   // échelle accel
    static constexpr uint8_t REG_ACCEL_XOUT_H = 0x3B;   // bloc AX..GZ (14 octets, temp incluse)
    static constexpr uint8_t REG_WHO_AM_I     = 0x75;   // doit répondre 0x68
    static constexpr uint8_t WHO_AM_I_VAL     = 0x68;

    // Sensibilités pour ±8 g et ±500 °/s (LSB par unité physique)
    static constexpr float ACC_LSB_PER_G   = 4096.0f;
    static constexpr float GYR_LSB_PER_DPS = 65.5f;
};

#endif // DRIVER_MPU6050_H
