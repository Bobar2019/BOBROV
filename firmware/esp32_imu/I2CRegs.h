// ============================================================================
// BOB-ROV · HAL IMU — Petits utilitaires d'accès registres I2C (header-only)
// ============================================================================
#ifndef I2C_REGS_H
#define I2C_REGS_H

#include <Arduino.h>
#include <Wire.h>

namespace I2CRegs {

// Écrit un octet dans un registre. Retourne true si l'esclave a acquitté.
inline bool write8(uint8_t addr, uint8_t reg, uint8_t val) {
    Wire.beginTransmission(addr);
    Wire.write(reg);
    Wire.write(val);
    return Wire.endTransmission() == 0;
}

// Lit un octet d'un registre (0x00 en cas d'échec bus).
inline uint8_t read8(uint8_t addr, uint8_t reg) {
    Wire.beginTransmission(addr);
    Wire.write(reg);
    if (Wire.endTransmission(false) != 0) return 0;
    if (Wire.requestFrom(addr, (uint8_t)1) != 1) return 0;
    return Wire.read();
}

// Lit un bloc de registres consécutifs. Retourne true si `len` octets reçus.
inline bool readBytes(uint8_t addr, uint8_t reg, uint8_t* buf, size_t len) {
    Wire.beginTransmission(addr);
    Wire.write(reg);
    if (Wire.endTransmission(false) != 0) return false;
    if (Wire.requestFrom(addr, (uint8_t)len) != len) return false;
    for (size_t i = 0; i < len; i++) buf[i] = Wire.read();
    return true;
}

// Un périphérique répond-il à cette adresse ? (utilisé par le scan factory)
inline bool ping(uint8_t addr) {
    Wire.beginTransmission(addr);
    return Wire.endTransmission() == 0;
}

} // namespace I2CRegs

#endif // I2C_REGS_H
