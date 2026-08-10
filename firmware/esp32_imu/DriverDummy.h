// ============================================================================
// BOB-ROV · HAL IMU — Driver Dummy / Fallback (aucun capteur détecté)
// Renvoie des angles neutres (0°) et ne touche jamais au bus : le firmware
// continue de tourner (télémétrie, WiFi, commandes) sans plantage.
// ============================================================================
#ifndef DRIVER_DUMMY_H
#define DRIVER_DUMMY_H

#include "IMUBase.h"

class DriverDummy : public IMUBase {
public:
    bool  begin() override  { return true; }   // toujours OK : ne peut pas échouer
    void  update() override {}                 // rien à lire
    float getRoll() override  { return 0.0f; }
    float getPitch() override { return 0.0f; }
    float getYaw() override   { return 0.0f; }
    void  calibrateZero() override { _calibrated = false; }   // tare impossible
    const char* name() const override { return "DUMMY"; }
};

#endif // DRIVER_DUMMY_H
