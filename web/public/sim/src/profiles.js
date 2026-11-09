// Controller profiles: pure math, no DOM. Format "pitwall-sim-profile/1".
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const isInt = v => Number.isInteger(v) && v >= 0 && v < 64;

export const PROFILE_FORMAT = 'pitwall-sim-profile/1';

// Standard mapping (DualShock 4 and other "standard" pads). profiles/standard.json must equal this.
export const STANDARD_PROFILE = {
  format: 'pitwall-sim-profile/1',
  name: 'Standard gamepad',
  device: null,
  steer: { axis: 0, invert: false, deadzone: 0.02, sens: 1 },
  throttle: { type: 'button', index: 7 },
  brake: { type: 'button', index: 6 },
  combined: null
};

function checkPedal(spec, label, errors) {
  if (!spec || typeof spec !== 'object') { errors.push(label + ' must be an object'); return; }
  if (spec.type === 'button') { if (!isInt(spec.index)) errors.push(label + '.index must be a button number'); }
  else if (spec.type === 'axis') {
    if (!isInt(spec.axis)) errors.push(label + '.axis must be an axis number');
    if (!isNum(spec.rest)) errors.push(label + '.rest must be a number');
    if (!isNum(spec.full)) errors.push(label + '.full must be a number');
    if (isNum(spec.rest) && isNum(spec.full) && spec.rest === spec.full) errors.push(label + ': rest and full must differ');
  } else errors.push(label + '.type must be "button" or "axis"');
}

export function validateProfile(obj) {
  const errors = [];
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, errors: ['profile must be an object'] };
  if (obj.format !== PROFILE_FORMAT) errors.push('format must be "' + PROFILE_FORMAT + '"');
  if (typeof obj.name !== 'string' || !obj.name) errors.push('name must be a non-empty string');
  if (obj.device !== null && typeof obj.device !== 'string') errors.push('device must be a string or null');
  const s = obj.steer;
  if (!s || typeof s !== 'object') errors.push('steer must be an object');
  else {
    if (!isInt(s.axis)) errors.push('steer.axis must be an axis number');
    if (typeof s.invert !== 'boolean') errors.push('steer.invert must be true or false');
    if (!isNum(s.deadzone) || s.deadzone < 0 || s.deadzone >= 1) errors.push('steer.deadzone must be 0 to 1');
    if (!isNum(s.sens) || s.sens <= 0 || s.sens > 5) errors.push('steer.sens must be above 0 and at most 5');
  }
  checkPedal(obj.throttle, 'throttle', errors);
  checkPedal(obj.brake, 'brake', errors);
  const c = obj.combined;
  if (c !== null && c !== undefined) {
    if (typeof c !== 'object') errors.push('combined must be null or an object');
    else {
      if (!isInt(c.axis)) errors.push('combined.axis must be an axis number');
      for (const k of ['rest', 'gas_end', 'brake_end']) if (!isNum(c[k])) errors.push('combined.' + k + ' must be a number');
      if (isNum(c.rest) && isNum(c.gas_end) && c.rest === c.gas_end) errors.push('combined: rest and gas_end must differ');
      if (isNum(c.rest) && isNum(c.brake_end) && c.rest === c.brake_end) errors.push('combined: rest and brake_end must differ');
    }
  } else if (c === undefined) errors.push('combined must be null or an object');
  return { ok: errors.length === 0, errors };
}

const toward = (v, rest, end) => clamp((v - rest) / ((end - rest) || 1), 0, 1);

export function readPedal(spec, axes, buttons) {
  if (!spec) return 0;
  if (spec.type === 'button') { const b = buttons && buttons[spec.index]; return b ? clamp(+b.value || (b.pressed ? 1 : 0), 0, 1) : 0; }
  const v = axes ? axes[spec.axis] : undefined;
  if (v === undefined) return 0;
  return toward(v, spec.rest, spec.full);
}

export function splitCombined(v, combined) {
  return { thr: toward(v, combined.rest, combined.gas_end), brk: toward(v, combined.rest, combined.brake_end) };
}

export function readControls(profile, gp) {
  const axes = gp.axes || [], buttons = gp.buttons || [];
  const s = profile.steer;
  let steer = axes[s.axis] || 0;
  if (Math.abs(steer) < s.deadzone) steer = 0;
  steer = clamp(steer * s.sens * (s.invert ? -1 : 1), -1, 1);
  let thr, brk;
  const c = profile.combined;
  if (c) {
    const v = axes[c.axis];
    if (v === undefined) { thr = 0; brk = 0; } else ({ thr, brk } = splitCombined(v, c));
  } else { thr = readPedal(profile.throttle, axes, buttons); brk = readPedal(profile.brake, axes, buttons); }
  return { thr, brk, steer };
}
