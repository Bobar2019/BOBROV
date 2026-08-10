// ============================================================================
// BOB-ROV · HAL IMU — Interface abstraite commune à toutes les centrales
// La logique de télémétrie ne manipule QUE cette interface : changer de
// capteur (QMI8658 / MPU6050 / ADXL345) ne demande aucune réécriture.
// ============================================================================
#ifndef IMU_BASE_H
#define IMU_BASE_H

#include <Arduino.h>

// ----------------------------------------------------------------------------
// Structure globale d'échange : angles en DEGRÉS, convention aéronautique
//   roll  : roulis  (rotation autour de l'axe longitudinal, + = tribord bas)
//   pitch : tangage (rotation autour de l'axe transversal, + = nez haut)
//   yaw   : lacet   (cap relatif, + = rotation horaire vue de dessus)
// ----------------------------------------------------------------------------
typedef struct {
    float roll;
    float pitch;
    float yaw;
    bool  isCalibrated;   // true après un calibrateZero() réussi
} IMUData_t;

// ----------------------------------------------------------------------------
// Classe de base abstraite : contrat minimal de tout driver IMU
// ----------------------------------------------------------------------------
class IMUBase {
public:
    virtual ~IMUBase() {}

    virtual bool  begin()  = 0;   // init capteur (I2C déjà démarré par la factory)
    virtual void  update() = 0;   // lecture + fusion, à appeler à cadence fixe
    virtual float getRoll()  = 0; // roulis (degrés)
    virtual float getPitch() = 0; // tangage (degrés)
    virtual float getYaw()   = 0; // lacet / cap (degrés) — 0.0f si non mesurable
    virtual void  calibrateZero() = 0;   // tare : la pose actuelle devient le zéro

    // Nom lisible du driver (diagnostic / trame de télémétrie)
    virtual const char* name() const = 0;

    // Renseigne la structure d'échange globale (formatage commun)
    void fillData(IMUData_t& out) {
        out.roll  = getRoll();
        out.pitch = getPitch();
        out.yaw   = getYaw();
        out.isCalibrated = _calibrated;
    }

protected:
    bool _calibrated = false;
};

#endif // IMU_BASE_H
