import type { AutopilotSafety, IntentDecision } from "./types.js";

interface IntentRule {
  intent: IntentDecision["intent"];
  confidence: number;
  safety: AutopilotSafety;
  reason: string;
  patterns: RegExp[];
}

const RULES: IntentRule[] = [
  {
    intent: "privacy_policy_change",
    confidence: 0.95,
    safety: "needs_confirmation",
    reason: "채팅방 개인 기억 사용 정책 변경 요청",
    patterns: [
      /(이\s*방|여기|그룹|단톡).*(개인\s*)?기억.*(써도\s*돼|사용.*허용|허용|켜|참고해)/,
      /(이\s*방|여기|그룹|단톡).*(개인\s*)?기억.*(쓰지\s*마|사용.*금지|끄|해제|차단)/,
      /이번\s*(답변|한\s*번).*개인\s*기억.*(참고|사용)/,
    ],
  },
  {
    intent: "task_cancel",
    confidence: 0.9,
    safety: "needs_confirmation",
    reason: "진행 중 작업 취소 요청",
    patterns: [
      /(작업|워커|조사|리서치).*(취소|멈춰|중단|그만|스톱)/,
      /(취소|멈춰|중단|그만).*(작업|워커|조사|리서치)/,
    ],
  },
  {
    intent: "task_status",
    confidence: 0.9,
    safety: "safe_read",
    reason: "진행 중이거나 최근 위임된 작업 상태 확인",
    patterns: [
      /(위임\s*(작업|태스크)|워커).*(어떻게\s*(됐|됬|돼|되)|상태|돌고|끝났|완료|목록|리스트|확인)/,
      /(그|저|이|아까|방금).*(작업|태스크).*(어떻게\s*(됐|됬|돼|되)|상태|돌고|끝났|완료)/,
      /(작업|태스크)\s*(상태|목록|리스트)\s*(확인|알려|보여|조회)?/,
      /(진행\s*중|돌고\s*있는)\s*(워커|위임\s*작업|작업).*(있|어|확인|알려|보여)?/,
      /(워커|위임\s*작업|작업).*(돌고\s*있는|진행\s*중).*(있|어|확인|알려|보여)/,
    ],
  },
  {
    intent: "meeting_end",
    confidence: 0.92,
    safety: "safe_write",
    reason: "회의모드 종료 및 저장 요청",
    patterns: [
      /회의.*(종료|끝내|마무리|저장)/,
      /(종료|끝내|마무리|저장).*회의/,
    ],
  },
  {
    intent: "meeting_start",
    confidence: 0.92,
    safety: "safe_write",
    reason: "회의모드 시작 요청",
    patterns: [
      /회의.*(시작|하자|열어|기록\s*시작)/,
      /(지금부터|이제).*(회의|미팅).*(기록|시작)/,
    ],
  },
  {
    intent: "meeting_summary",
    confidence: 0.88,
    safety: "safe_read",
    reason: "최근 회의 내용 조회 또는 요약 요청",
    patterns: [
      /(아까|최근|방금|지난).*(회의|미팅).*(정리|요약|내용|결정)/,
      /(회의|미팅).*(내용|요약|정리|결정사항|액션\s*아이템)/,
    ],
  },
  {
    intent: "memory_write_candidate",
    confidence: 0.86,
    safety: "safe_write",
    reason: "장기기억 저장 후보 요청",
    patterns: [
      /(기억|장기\s*기억|Brain|브레인).*(해둬|해줘|해라|남겨|등록|저장)/i,
      /(이거|내용).*(기억|장기\s*기억|Brain|브레인).*(해|남겨|저장)/i,
    ],
  },
  {
    intent: "memory_recall",
    confidence: 0.84,
    safety: "safe_read",
    reason: "Brain 장기기억 조회 요청",
    patterns: [
      /(전에|예전에|일전에|아까).*(말한|얘기한|정한|했던|알고)/,
      /(기억나|기억하지|알고\s*있|찾아봐|뭐였지)/,
      /(HTML|html|산출물).*(가능|지원|기억|알고)/,
    ],
  },
  {
    intent: "dev_handoff",
    confidence: 0.84,
    safety: "needs_confirmation",
    reason: "개발 세션 또는 VS Code 위임 요청",
    patterns: [
      /(VS\s*Code|vscode|코덱스|Codex|데탑클로|데스크탑클로).*(전달해|전달해줘|넘겨줘|넘겨|위임해|위임해줘|맡겨|맡겨줘|처리해줘|처리해|작업해줘|반영해줘|보내줘|보내라)/i,
      /(전달해|전달해줘|넘겨줘|넘겨|위임해|위임해줘|맡겨|맡겨줘|처리해줘|처리해|작업해줘|반영해줘|보내줘|보내라).*(VS\s*Code|vscode|코덱스|Codex|데탑클로|데스크탑클로)/i,
      /(프로젝트|코드).*(수정|구현|빌드|테스트).*(넘겨줘|넘겨|처리해줘|처리해|시켜|위임해|전달해)/,
    ],
  },
  {
    intent: "media_reference",
    confidence: 0.82,
    safety: "safe_read",
    reason: "최근 미디어 참조 요청",
    patterns: [
      /(아까|위에|방금).*(영상|사진|이미지|동영상|파일).*(봐|분석|확인|설명|정리)/,
      /(영상|사진|이미지|동영상).*(봐줘|분석해|확인해)/,
    ],
  },
  {
    intent: "health_check",
    confidence: 0.8,
    safety: "safe_read",
    reason: "텔레클로 동작 상태 또는 오류 확인 요청",
    patterns: [
      /(왜|뭐가).*(이상|오류|문제|안\s*돼|안돼)/,
      /(상태|헬스|health).*(확인|체크)/i,
      /(답|응답).*(이상|반복|틀렸|못\s*해)/,
    ],
  },
  {
    intent: "async_research",
    confidence: 0.78,
    safety: "safe_read",
    reason: "장시간 조사 또는 분석 요청",
    patterns: [
      /(길게|정밀|심층|전체|대규모|오래|깊게).*(조사|분석|리서치|검토)/,
      /(논문|오픈소스|레포|repository|repo).*(정밀|심층|분석|검토)/i,
      /(조사|리서치).*(설계서|지시서|문서|정리)/,
    ],
  },
];

export class IntentRouter {
  classify(text: string): IntentDecision {
    const normalized = normalizeText(text);
    if (!normalized) return pass("빈 입력");
    if (normalized.startsWith("/")) return pass("명시적 slash command는 기존 handler가 처리");


    for (const rule of RULES) {
      if (rule.intent === "task_status" && !isExplicitTaskStatusRequest(normalized)) {
        continue;
      }
      if (rule.intent === "memory_recall" && !isExplicitMemoryRecallRequest(normalized)) {
        continue;
      }
      if (rule.intent === "dev_handoff" && !isExplicitDevHandoffRequest(normalized)) {
        continue;
      }
      if (rule.intent === "memory_write_candidate" && isObsidianSaveRequest(normalized)) {
        continue;
      }
      if (rule.patterns.some((pattern) => pattern.test(normalized))) {
        return {
          intent: rule.intent,
          confidence: rule.confidence,
          safety: rule.safety,
          reason: rule.reason,
          entities: extractEntities(normalized, rule.intent),
        };
      }
    }

    return pass("자동 실행 의도가 명확하지 않음");
  }
}

function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

export function isExplicitTaskStatusRequest(text: string): boolean {
  const normalized = normalizeText(text);
  if (!normalized || normalized.startsWith("/")) return false;

  const explicitStatusPatterns = [
    /(위임\s*(작업|태스크)|워커).*(상태|목록|리스트|조회|확인|보여|알려|어떻게|돌고|진행|끝났|완료|결과)/,
    /(작업|태스크)\s*(상태|목록|리스트)\s*(확인|알려|보여|조회)?/,
    /(그|저|이|아까|방금)\s*(작업|태스크).*(어떻게\s*(됐|됬|돼|되)|끝났(어|나|니|냐|습니까)?|완료\s*\?|완료(됐|됬|돼|되|했|한\s*거야|야|니|냐)|결과|상태|어디까지)/,
    /(진행\s*중|돌고\s*있는)\s*(워커|위임\s*작업|작업).*(있(어|나|니|냐|습니까|\?)|확인|알려|보여|조회|\?)/,
    /(워커|위임\s*작업|작업).*(돌고\s*있는|진행\s*중).*(있(어|나|니|냐|습니까|\?)|확인|알려|보여|조회|\?)/,
    /(작업|워커|태스크).*(뭐\s*(해|하고)|어디까지|결과\s*(나왔|알려|보여))/,
  ];

  return explicitStatusPatterns.some((pattern) => pattern.test(normalized));
}

export function isExplicitMemoryWriteRequest(text: string): boolean {
  const normalized = normalizeText(text);
  if (!normalized || normalized.startsWith("/")) return false;
  if (isDocumentOrFileSaveRequest(normalized)) return false;

  const explicitMemoryWritePatterns = [
    /(기억|장기\s*기억|Brain|브레인).*(해둬|해줘|해라|남겨|등록|저장)/i,
    /(이거|내용).*(기억|장기\s*기억|Brain|브레인).*(해|남겨|저장)/i,
  ];

  return explicitMemoryWritePatterns.some((pattern) => pattern.test(normalized));
}
export function isExplicitProjectWorkRequest(text: string): boolean {
  const normalized = normalizeText(text);
  if (!normalized || normalized.startsWith("/")) return false;

  const projectPath = extractExplicitLocalPath(normalized);
  if (!projectPath) return false;

  const remainder = normalized.replace(projectPath, "").trim();
  if (isExplicitMemoryWriteRequest(remainder)) return false;
  if (!remainder) return false;
  if (isPathInquiry(remainder)) return false;

  return true;
}

function extractExplicitLocalPath(text: string): string | null {
  return /(?:^|[\s([{<])((?:[A-Z]:[\\/]|[\\/]{2})[^\s"'<>|?*]+)/i.exec(text)?.[1] ?? null;
}

function isPathInquiry(text: string): boolean {
  return /(\?|어디|무엇|뭐|상태|맞아|맞나|존재|있어|조회|확인만)/.test(text);
}
export function isExplicitDevHandoffRequest(text: string): boolean {
  const normalized = normalizeText(text);
  const explicitHandoffPatterns = [
    /(VS\s*Code|vscode|코덱스|Codex|데탑클로|데스크탑클로).*(전달|넘겨|위임|맡겨|시켜|처리해|작업해|반영해|수정해|구현해|보내(?:\s*(?:줘|라|주세요|주라)|$|[.!?]))/i,
    /(전달|넘겨|위임|맡겨|시켜|처리해|작업해|반영해|수정해|구현해|보내(?:\s*(?:줘|라|주세요|주라)|$|[.!?])).*(VS\s*Code|vscode|코덱스|Codex|데탑클로|데스크탑클로)/i,
    /(프로젝트|코드).*(수정|구현|빌드|테스트).*(넘겨|처리해|시켜|위임|전달)/,
  ];

  return explicitHandoffPatterns.some((pattern) => pattern.test(normalized));
}

function isExplicitMemoryRecallRequest(text: string): boolean {
  const normalized = normalizeText(text);
  const explicitRecallPatterns = [
    /(전에|예전에|일전에|아까).*(말한|얘기한|정한|했던).*(기억|찾아|뭐였|알려|확인|내용)/,
    /(기억나|기억하지|찾아봐|뭐였지)/,
    /알고\s*있(어(?!야)|니|냐|습니까|\?)/,
    /(HTML|html|산출물).*(가능|지원|기억|알고).*(기억나|기억하지|알고\s*있(어(?!야)|니|냐|습니까|\?)|찾아|확인|알려|뭐였)/,
  ];

  return explicitRecallPatterns.some((pattern) => pattern.test(normalized));
}

function isObsidianSaveRequest(text: string): boolean {
  return isDocumentOrFileSaveRequest(text);
}

function isDocumentOrFileSaveRequest(text: string): boolean {
  return (
    /(옵시디언|obsidian|AI학습|ai학습|지식창고|폴더|디렉토리|경로|파일|문서|설계서|기획서|보고서|[A-Z]:[\\/])/i.test(text) &&
    /(저장|추가|작성|생성|남겨|올려)/.test(text)
  );
}

function pass(reason: string): IntentDecision {
  return {
    intent: "general_chat",
    confidence: 0.2,
    safety: "pass_to_llm",
    reason,
    entities: {},
  };
}

function extractEntities(text: string, intent: IntentDecision["intent"]): Record<string, string> {
  const entities: Record<string, string> = {};
  if (intent === "privacy_policy_change") {
    entities.action = /(쓰지\s*마|금지|끄|해제|차단)/.test(text) ? "disable" : "enable";
    if (/이번\s*(답변|한\s*번)/.test(text)) entities.scope = "once";
  }
  if (intent === "meeting_end") {
    if (/정밀/.test(text)) entities.summaryMode = "precise";
    if (/저장만/.test(text)) entities.summaryMode = "none";
  }
  if (intent === "async_research") {
    entities.prompt = text;
  }
  if (intent === "memory_recall") {
    entities.goal = text;
  }
  return entities;
}




