import { buildColumnSpec, isTemporarySession } from "./packages/coding-agent/src/modes/resume-modal/resume-modal-types.ts";

const spec = buildColumnSpec(200);
console.log("detailWidth >= 40:", spec.detailWidth >= 40, spec.detailWidth);

console.log("isTemporarySession(/tmp/pi-handoff-ABC123):", isTemporarySession({ cwd: '/tmp/pi-handoff-ABC123' } as any));
console.log("isTemporarySession(/home/user/project):", isTemporarySession({ cwd: '/home/user/project' } as any));
console.log("isTemporarySession(''):", isTemporarySession({ cwd: '' } as any));
