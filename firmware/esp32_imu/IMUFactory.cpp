// ============================================================================
// BOB-ROV · HAL IMU — Factory (implémentation) : scan I2C + instanciation
// ============================================================================
#include <Wire.h>
#include "IMUFactory.h"
#include "I2CRegs.h"
#include "config_pins.h"
#include "DriverQMI8658.h"
#include "DriverMPU6050.h"
#include "DriverADXL345.h"
#include "DriverDummy.h"

namespace IMUFactory {

// Tente un driver : instanciation + begin(). Détruit et retourne nullptr si KO.
static IMUBase* tryDriver(IMUBase* drv) {
    if (drv->begin()) {
        Serial.printf("[IMU] Capteur initialisé : %s\n", drv->name());
        return drv;
    }
    Serial.printf("[IMU] Échec init %s (présent sur le bus mais begin() KO)\n", drv->name());
    delete drv;
    return nullptr;
}

IMUBase* createAutoDetected() {
    // Bus I2C principal : GPIO 8 (SDA) / GPIO 9 (SCL) à 400 kHz
    Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL, I2C_FREQ_HZ);
    delay(50);   // laisse les capteurs sortir de leur power-on reset

    Serial.printf("[IMU] Scan I2C (SDA=%d SCL=%d @ %lu Hz)...\n",
                  PIN_I2C_SDA, PIN_I2C_SCL, (unsigned long)I2C_FREQ_HZ);

    IMUBase* imu = nullptr;

    // Ordre de préférence : 6 axes d'abord (yaw disponible), 3 axes ensuite
    if (I2CRegs::ping(ADDR_QMI8658)) {
        Serial.printf("[IMU] 0x%02X répond → tentative QMI8658\n", ADDR_QMI8658);
        imu = tryDriver(new DriverQMI8658(ADDR_QMI8658));
    }
    if (!imu && I2CRegs::ping(ADDR_MPU6050)) {
        Serial.printf("[IMU] 0x%02X répond → tentative MPU6050\n", ADDR_MPU6050);
        imu = tryDriver(new DriverMPU6050(ADDR_MPU6050));
    }
    if (!imu && I2CRegs::ping(ADDR_ADXL345)) {
        Serial.printf("[IMU] 0x%02X répond → tentative ADXL345\n", ADDR_ADXL345);
        imu = tryDriver(new DriverADXL345(ADDR_ADXL345));
    }

    // Fallback : aucun capteur détecté/initialisé → Dummy (jamais nullptr)
    if (!imu) {
        Serial.println("[IMU] ⚠️ Aucune centrale détectée : driver DUMMY actif "
                       "(angles à 0°, système opérationnel).");
        imu = new DriverDummy();
        imu->begin();
    }
    return imu;
}

} // namespace IMUFactory
