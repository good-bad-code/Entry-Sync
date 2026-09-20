# Contributing to Entry Sync

Entry Sync에 관심을 가져주시고 기여해주셔서 감사합니다! ❤️

Entry Sync는 엔트리(Entry) 작품을 위한 실시간 동기화 및 클라우드 저장 기능을 제공하는 오픈소스 Chrome 확장프로그램입니다.

버그 수정, 기능 개선, 문서 수정, 아이디어 제안 등 다양한 형태의 기여를 환영합니다.

---

## 📌 시작하기 전에

기여하기 전에 다음 사항을 확인해주세요.

- 기존 Issues와 Pull Requests에 동일하거나 유사한 내용이 있는지 확인해주세요.
- 큰 기능을 추가하거나 기존 동작을 변경하는 경우 Issue에서 먼저 논의해주세요.
- 기존 프로젝트의 구조와 코딩 스타일을 최대한 존중해주세요.
- 개인정보, API 키, 비밀번호 및 기타 민감한 정보를 커밋하지 마세요.
- 변경 사항을 제출하기 전에 직접 테스트해주세요.

---

## 🐛 버그 제보

버그를 발견했다면 [GitHub Issues](../../issues)에 제보해주세요.

가능하면 다음 정보를 함께 작성해주세요.

- 문제가 발생한 환경
- 사용 중인 브라우저 및 버전
- Entry Sync 버전
- 문제가 발생하는 과정
- 예상했던 동작
- 실제로 발생한 동작
- 재현 방법
- 관련 스크린샷 또는 콘솔 오류

보안 취약점은 공개 Issue에 작성하지 말고
[`SECURITY.md`](SECURITY.md)에 안내된 방법을 이용해주세요.

---

## 💡 기능 제안

새로운 기능이나 개선 아이디어도 [GitHub Issues](../../issues)를 통해 제안해주세요.

제안할 때 다음 내용을 포함하면 도움이 됩니다.

- 어떤 문제를 해결하려는지
- 어떤 기능을 제안하는지
- 해당 기능이 어떻게 동작하면 좋을지
- 기존 기능에 어떤 영향을 줄 수 있는지

작은 아이디어라도 자유롭게 제안해주세요!

---

## 🔧 개발 환경

Entry Sync의 Chrome 확장프로그램 소스 코드는 `extension/` 디렉터리에 있습니다.

주요 구조는 다음과 같습니다.

```text
extension/
├── manifest.json
├── content.js
├── inject.js
├── popup.html
├── popup.js
└── icons/
````

### 주요 파일

| 파일              | 설명                           |
| --------------- | ---------------------------- |
| `manifest.json` | Chrome Extension Manifest 설정 |
| `content.js`    | 엔트리 웹페이지와 확장프로그램 간 통신        |
| `inject.js`     | 엔트리 페이지 내부의 변수 및 상태 처리       |
| `popup.html`    | 확장프로그램 팝업 UI                 |
| `popup.js`      | 팝업의 상태 및 동작 처리               |
| `icons/`        | 확장프로그램 아이콘                   |

프로젝트의 전체 구조와 동작 방식은
[README.md](README.md)의 시스템 아키텍처 및 프로젝트 구조를 참고해주세요.

---

## 🌿 브랜치

변경 사항을 작업할 때는 별도의 브랜치를 사용하는 것을 권장합니다.

예:

```text
feature/add-new-feature
fix/sync-error
docs/update-readme
refactor/improve-sync
```

---

## 💾 커밋 메시지

커밋 메시지는 변경 내용을 이해하기 쉽도록 작성해주세요.

예:

```text
feat: add synchronization status indicator
fix: fix websocket connection issue
docs: update installation guide
refactor: simplify synchronization logic
```

가능하면 하나의 커밋에는 하나의 목적을 담아주세요.

---

## 🔀 Pull Request

Pull Request를 제출하기 전에 다음 사항을 확인해주세요.

* [ ] 변경 사항을 직접 테스트했습니다.
* [ ] 기존 기능이 정상적으로 작동하는지 확인했습니다.
* [ ] 불필요한 파일이나 변경 사항을 포함하지 않았습니다.
* [ ] 민감한 정보가 포함되어 있지 않습니다.
* [ ] 필요한 경우 관련 Issue를 연결했습니다.
* [ ] 변경 사항을 설명하는 내용을 Pull Request에 작성했습니다.

Pull Request에는 다음 내용을 포함해주세요.

### 변경 내용

무엇을 변경했는지 설명해주세요.

### 변경 이유

왜 이 변경이 필요한지 설명해주세요.

### 테스트

어떤 환경에서 어떻게 테스트했는지 작성해주세요.

---

## 🧐 Code Review

제출된 Pull Request는 프로젝트 유지관리자의 검토를 받을 수 있습니다.

리뷰 과정에서 질문이나 수정 요청이 있을 수 있습니다.

수정 요청은 프로젝트의 품질과 안정성을 높이기 위한 과정이므로 서로 존중하며 건설적으로 의견을 나눠주세요.

---

## 📜 라이선스

Entry Sync는 [MIT License](LICENSE)에 따라 배포됩니다.

프로젝트에 기여한 코드 역시 프로젝트의 라이선스 정책을 따릅니다.

---

## 🤝 커뮤니티

Entry Sync는 모든 기여자를 환영합니다.

코드 작성뿐만 아니라 다음과 같은 활동도 프로젝트에 도움이 됩니다.

* 버그 제보
* 기능 제안
* 문서 개선
* 사용 경험 공유
* 테스트
* Pull Request 리뷰
* 프로젝트에 대한 피드백

작은 기여도 프로젝트를 발전시키는 데 도움이 됩니다.

---

Entry Sync에 관심을 가져주시고 함께 만들어주셔서 감사합니다! 🚀

**Built with ❤️ for the Entry Creator Community**
