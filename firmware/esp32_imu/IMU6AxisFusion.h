// ============================================================================
// BOB-ROV · HAL IMU — Base commune des centrales 6 axes (Accel + Gyro)
// Fusion par FILTRE COMPLÉMENTAIRE + correction de dérive du gyroscope :
//   - roll/pitch : intégration gyro recalée en continu sur la gravité (accel)
//   - yaw        : intégration gyro seule (pas de magnétomètre), biais soustrait
// Le biais gyro est estimé au begin() (capteur immobile) et ré-estimé à chaque
// calibrateZero(), ce qui élimine l'essentiel de la dérive (gyro drift).
// ============================================================================
#ifndef IMU_6AXIS_FUSION_H
#define IMU_6AXIS_FUSION_H

#include "IMUBase.h"

class IMU6AxisFusion : public IMUBase {
public:
    void  update() override;
    float getRoll() override  { return _roll  - _rollZero; }
    float getPitch() override { return _pitch - _pitchZero; }
    float getYaw() override   { return _yaw   - _yawZero; }
    void  calibrateZero() override;

protected:
    // À fournir par le driver concret : une lecture brute convertie en unités
    // physiques (accel en g, gyro en °/s). Retourne false si la lecture échoue.
    virtual bool readRaw(float& ax, float& ay, float& az,
                         float& gx, float& gy, float& gz) = 0;

    // Estimation du biais gyro : moyenne de N lectures, CAPTEUR IMMOBILE.
    void estimateGyroBias(uint16_t samples = 200);

    // Initialise les angles depuis l'accéléromètre (pose de départ propre)
    void seedAnglesFromAccel();

    // Coefficient du filtre complémentaire : part accordée au gyro (0..1).
    // 0.98 = angles fluides (gyro) recalés en douceur par la gravité (accel).
    static constexpr float FUSION_ALPHA = 0.98f;

    float _gyroBias[3] = { 0, 0, 0 };   // biais °/s (drift) soustrait à chaque update
    float _roll = 0, _pitch = 0, _yaw = 0;             // angles fusionnés (°)
    float _rollZero = 0, _pitchZero = 0, _yawZero = 0; // offsets de tare (°)
    uint32_t _lastUs = 0;               // horodatage µs de la dernière fusion
};

#endif // IMU_6AXIS_FUSION_H
