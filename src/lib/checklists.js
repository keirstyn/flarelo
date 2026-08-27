export const CHECKLISTS = {
  fire_extinguisher: [
    { id: 'pressure_gauge', label: 'Pressure gauge reads in the green/operable zone' },
    { id: 'pin_seal', label: 'Safety pin and tamper seal are intact' },
    { id: 'nozzle_clear', label: 'Nozzle/hose is unobstructed and undamaged' },
    { id: 'mounting', label: 'Mounting bracket or stand is secure' },
    { id: 'tag_legible', label: 'Inspection tag is present and legible' },
  ],
  alarm_system: [
    { id: 'panel_power', label: 'Control panel is powered with no active fault lights' },
    { id: 'battery_backup', label: 'Battery backup tested under load' },
    { id: 'sensors_respond', label: 'Sensors/detectors respond to test' },
    { id: 'sounder_strobe', label: 'Sounder and strobe are audible/visible' },
    { id: 'programming', label: 'Panel programming matches the as-built zone list' },
  ],
  sprinkler_system: [
    { id: 'main_valve', label: 'Main control valve is open and locked/supervised' },
    { id: 'gauge_pressure', label: 'Gauges show normal system pressure' },
    { id: 'no_leaks', label: 'No visible leaks or corrosion on piping/heads' },
    { id: 'heads_clear', label: 'Sprinkler heads are unobstructed' },
    { id: 'fdc_caps', label: 'Fire department connection caps are in place' },
  ],
  kitchen_suppression: [
    { id: 'nozzles_aligned', label: 'Nozzles are unobstructed and properly aligned' },
    { id: 'fusible_links', label: 'Fusible links are within their service life' },
    { id: 'pull_station', label: 'Manual pull station is accessible and unobstructed' },
    { id: 'cylinder_charge', label: "Cylinder pressure/weight is within manufacturer's range" },
    { id: 'shutoff_verified', label: 'Fuel/electrical shutoff on activation is verified' },
  ],
};

export function getChecklistForAssetType(assetType) {
  return CHECKLISTS[assetType] ?? null;
}
