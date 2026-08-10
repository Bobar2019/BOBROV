// ============================================================================
// BOB-ROV · HAL IMU — Factory : auto-détection du capteur au démarrage
// ============================================================================
#ifndef IMU_FACTORY_H
#define IMU_FACTORY_H

#include "IMUBase.h"

namespace IMUFactory {

// Démarre le bus I2C (GPIO SDA/SCL de config_pins.h, 400 kHz), scanne les
// adresses connues et retourne le driver correspondant, initialisé (begin()
// déjà appelé). En dernier recours : DriverDummy — jamais nullptr.
IMUBase* createAutoDetected();

} // namespace IMUFactory

#endif // IMU_FACTORY_H
