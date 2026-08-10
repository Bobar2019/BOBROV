// ============================================================================
// BOB-ROV · HAL IMU — Fusion complémentaire 6 axes (implémentation commune)
// ============================================================================
#include "IMU6AxisFusion.h"

// Fusion : accel (référence gravité, bruyante) + gyro (fluide, mais dérive).
void IMU6AxisFusion::update() {
    float ax, ay, az, gx, gy, gz;
    if (!readRaw(ax, ay, az, gx, gy, gz)) return;   // lecture ratée : on garde l'état

    const uint32_t nowUs = micros();
    float dt = (_lastUs == 0) ? 0.0f : (nowUs - _lastUs) * 1e-6f;
    _lastUs = nowUs;
    if (dt <= 0.0f || dt > 0.2f) return;   // 1er appel ou trou > 200 ms : pas d'intégration

    // 1. Correction de dérive : biais estimé soustrait des vitesses angulaires
    gx -= _gyroBias[0];
    gy -= _gyroBias[1];
    gz -= _gyroBias[2];

    // 2. Angles gravité (accéléromètre) — valides uniquement en quasi-statique
    const float accRoll  = atan2f(ay, az) * RAD_TO_DEG;
    const float accPitch = atan2f(-ax, sqrtf(ay * ay + az * az)) * RAD_TO_DEG;

    // 3. Filtre complémentaire : intégration gyro recalée sur l'accel.
    //    Si l'accélération s'écarte trop de 1 g (choc / poussée moteur), la
    //    référence gravité est faussée : on n'intègre alors que le gyro.
    const float accNorm = sqrtf(ax * ax + ay * ay + az * az);
    const bool accTrusted = (accNorm > 0.7f && accNorm < 1.3f);
    if (accTrusted) {
        _roll  = FUSION_ALPHA * (_roll  + gx * dt) + (1.0f - FUSION_ALPHA) * accRoll;
        _pitch = FUSION_ALPHA * (_pitch + gy * dt) + (1.0f - FUSION_ALPHA) * accPitch;
    } else {
        _roll  += gx * dt;
        _pitch += gy * dt;
    }

    // 4. Yaw : gyro seul (aucune référence absolue sans magnétomètre),
    //    maintenu dans [-180, +180] pour une trame de télémétrie propre.
    _yaw += gz * dt;
    if (_yaw > 180.0f) _yaw -= 360.0f;
    else if (_yaw < -180.0f) _yaw += 360.0f;
}

// Biais gyro = moyenne de N lectures capteur immobile (à l'init et à la tare)
void IMU6AxisFusion::estimateGyroBias(uint16_t samples) {
    float sum[3] = { 0, 0, 0 };
    uint16_t got = 0;
    for (uint16_t i = 0; i < samples; i++) {
        float ax, ay, az, gx, gy, gz;
        if (readRaw(ax, ay, az, gx, gy, gz)) {
            sum[0] += gx; sum[1] += gy; sum[2] += gz;
            got++;
        }
        delay(2);   // ~2 ms entre lectures (ODR capteurs >= 500 Hz)
    }
    if (got > samples / 2) {
        _gyroBias[0] = sum[0] / got;
        _gyroBias[1] = sum[1] / got;
        _gyroBias[2] = sum[2] / got;
    }
}

// Pose de départ : angles initialisés depuis la gravité (évite la convergence lente)
void IMU6AxisFusion::seedAnglesFromAccel() {
    float ax, ay, az, gx, gy, gz;
    if (readRaw(ax, ay, az, gx, gy, gz)) {
        _roll  = atan2f(ay, az) * RAD_TO_DEG;
        _pitch = atan2f(-ax, sqrtf(ay * ay + az * az)) * RAD_TO_DEG;
    }
    _yaw = 0.0f;
    _lastUs = 0;
}

// Tare : ré-estime le biais gyro (drift) puis fait de la pose actuelle le zéro.
// Le ROV doit être immobile et à l'horizontale pendant l'appel (~0,5 s).
void IMU6AxisFusion::calibrateZero() {
    estimateGyroBias();
    seedAnglesFromAccel();
    _rollZero  = _roll;
    _pitchZero = _pitch;
    _yawZero   = _yaw;
    _calibrated = true;
}
