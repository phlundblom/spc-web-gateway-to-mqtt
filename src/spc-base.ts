export enum AreaStatus {
  UNSET = 0,
  PART_SET_A = 1,
  PART_SET_B = 2,
  FULL_SET = 3,
}

export enum ZoneInput {
  CLOSED = 0,
  OPEN,
  SHORT,
  DISCONNECTED,
  PIR_MASKED,
  DC_SUBSTITUTION,
  SENSOR_MISSING,
  OFFLINE,
}

export enum ZoneStatus {
  OK = 0,
  INHIBIT,
  ISOLATE,
  SOAK,
  TAMPER,
  ALARM,
  OK_OLD,
  TROUBLE,
}

export enum ZoneType {
  ALARM = 0,
  ENTRY_EXIT,
  EXIT_TERMINATOR,
  FIRE,
  FIRE_EXIT,
  LINE,
  PANIC,
  HOLD_UP,
  TAMPER,
  TECHNICAL,
  MEDICAL,
  KEYARM,
  UNUSED,
  SHUNT,
  X_SHUNT,
  FAULT,
  LOCK_SUPERVISION,
  SEISMIC,
  ALL_OKAY,
}

export function siaToZoneInput(siaCode: string) {
  switch (siaCode) {
    case 'ZO':
      return ZoneInput.OPEN;
    case 'ZC':
      return ZoneInput.CLOSED;
    case 'ZX':
      return ZoneInput.SHORT;
    case 'ZD':
      return ZoneInput.DISCONNECTED;
    case 'ZM':
      return ZoneInput.PIR_MASKED;
    default:
      return ZoneInput.OFFLINE;
  }
}
