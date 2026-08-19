const AVATAR_TOTAL = 36;

const BEHAVIOR_ART = Object.freeze({
  'b-speak': '/assets/behaviors/b-speak.webp',
  'b-help': '/assets/behaviors/b-help.webp',
  'b-focus': '/assets/behaviors/b-focus.webp',
  'b-homework': '/assets/behaviors/b-homework.webp',
  'b-duty': '/assets/behaviors/b-duty.webp',
  'b-progress': '/assets/behaviors/b-progress.webp',
  'b-talk': '/assets/behaviors/b-talk.webp',
  'b-late': '/assets/behaviors/b-late.webp',
  'b-nobook': '/assets/behaviors/b-nobook.webp',
  'b-phone': '/assets/behaviors/b-phone.webp',
  'b-nohw': '/assets/behaviors/b-nohw.webp',
  'b-conflict': '/assets/behaviors/b-conflict.webp',
});

function avatarPath(index) {
  return `/assets/avatars/avatar-${String((index % AVATAR_TOTAL) + 1).padStart(2, '0')}.webp`;
}

function stableIndex(value) {
  let hash = 0;
  for (const char of String(value || 'student')) {
    hash = ((hash * 31) + char.codePointAt(0)) >>> 0;
  }
  return hash % AVATAR_TOTAL;
}

export function behaviorArtPath(behaviorId) {
  return BEHAVIOR_ART[behaviorId] || '';
}

export function studentAvatarPath(studentId, classes = []) {
  let index = 0;
  for (const cls of classes) {
    for (const student of cls.students || []) {
      if (student.id === studentId) return avatarPath(index);
      index += 1;
    }
  }
  return avatarPath(stableIndex(studentId));
}

export { AVATAR_TOTAL, BEHAVIOR_ART };
