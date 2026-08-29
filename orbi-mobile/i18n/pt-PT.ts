// European Portuguese (pt-PT) strings.
//
// Keys are the English source text, so a missing entry falls back to
// readable English rather than a raw key like "settings.title". That
// also means adding a new English string never breaks this build — it
// just shows in English until someone adds a line here.
//
// Portugal vocabulary throughout, never Brazilian: "telemóvel" not
// "celular", "ecrã" not "tela", "utilizador" not "usuário",
// "a carregar" not "carregando".

export const ptPT: Record<string, string> = {
  // --- auth -------------------------------------------------------------
  "Welcome back": "Bem-vindo de volta",
  "Sign in to your Orbi universe": "Entra no teu universo Orbi",
  "Email": "Email",
  "Password": "Palavra-passe",
  "Sign in": "Entrar",
  "New to Orbi?": "Novo no Orbi?",
  "Create an account": "Criar uma conta",
  "you@example.com": "tu@exemplo.com",
  "Create your universe": "Cria o teu universo",
  "Full name": "Nome completo",
  "Jane Doe": "Maria Silva",
  "At least 6 characters": "Pelo menos 6 caracteres",
  "Create account": "Criar conta",
  "Already have an account?": "Já tens conta?",
  "Free plan, no card required": "Plano gratuito, sem cartão",

  // --- tabs / universe --------------------------------------------------
  "Tasks": "Tarefas",
  "Universe": "Universo",
  "Money": "Dinheiro",
  "Task": "Tarefa",
  "Cluster": "Grupo",
  "Listening…": "A ouvir…",
  "Parsing…": "A interpretar…",
  "Retry": "Tentar de novo",
  "Could not load tasks": "Não foi possível carregar as tarefas",
  "No tasks here yet": "Ainda não há tarefas aqui",
  "Re-center": "Centrar",
  "Your universe is empty": "O teu universo está vazio",
  "No active tasks": "Sem tarefas activas",
  "Hold the mic or tap + on the Universe to add one.":
    "Mantém o micro premido ou toca em + no Universo para adicionar uma.",

  // --- tasks tab --------------------------------------------------------
  "Filter tasks": "Filtrar tarefas",
  "Priority": "Prioridade",
  "Due date": "Data limite",
  "No matches": "Sem resultados",
  "related": "relacionada",
  "{n} active": "{n} activas",
  "{n} of {total}": "{n} de {total}",

  // --- search -----------------------------------------------------------
  "Search": "Pesquisar",
  "What are you looking for?": "O que procuras?",
  "Close": "Fechar",

  // --- new task ---------------------------------------------------------
  "New task": "Nova tarefa",
  "What needs doing?": "O que precisas de fazer?",
  "Bubble label": "Etiqueta da bolha",
  "Auto-filled from title": "Preenchida a partir do título",
  "No cluster": "Sem grupo",
  "Due": "Prazo",
  "Clear": "Limpar",
  "Cancel": "Cancelar",
  "Done": "Concluído",
  "Add to universe": "Adicionar ao universo",

  // --- voice confirm ----------------------------------------------------
  "Confirm task": "Confirmar tarefa",
  "You said": "Disseste",
  "Parsed title": "Título interpretado",
  "Description": "Descrição",
  "Importance": "Importância",
  "Skip": "Ignorar",
  "Edit cluster": "Editar grupo",
  "Nothing matches \"{q}\".": "Nada corresponde a \"{q}\".",
  "Add & next": "Adicionar e seguinte",
  "Could not read voice payload": "Não foi possível ler a captura de voz",
  "Short keyword shown inside the bubble":
    "Palavra curta mostrada dentro da bolha",
  "Sub-items, notes, context — empty if none":
    "Sub-itens, notas, contexto — vazio se não houver",
  "What you'll see in the bubble. Edit it now or keep what we picked.":
    "O que vais ver na bolha. Edita agora ou mantém o que escolhemos.",
  "We auto-fill this when you mention details like item lists or specifics. Leave blank for simple tasks.":
    "Preenchemos isto quando mencionas detalhes como listas ou especificidades. Deixa em branco para tarefas simples.",
  "Parse confidence: {n}%": "Confiança da interpretação: {n}%",
  "Task {n} of {total}": "Tarefa {n} de {total}",

  // --- task detail ------------------------------------------------------
  "Title": "Título",
  "Pressure": "Pressão",
  "Edit": "Editar",
  "Save changes": "Guardar alterações",
  "Task not found": "Tarefa não encontrada",
  "Hold to mark complete": "Mantém premido para concluir",
  "Short keyword shown in the bubble": "Palavra curta mostrada na bolha",
  "Add notes — context, why it matters, who's involved…":
    "Adiciona notas — contexto, porque importa, quem está envolvido…",
  "Are you sure you want to delete this task?":
    "Tens a certeza que queres apagar esta tarefa?",
  "This will remove the task from your universe.":
    "Isto remove a tarefa do teu universo.",
  "Delete": "Apagar",
  "Yes, delete": "Sim, apagar",
  "OK": "OK",

  // --- move task --------------------------------------------------------
  "Move task": "Mover tarefa",
  "Move to": "Mover para",
  "Drift (no cluster)": "Deriva (sem grupo)",

  // --- clusters ---------------------------------------------------------
  "Name": "Nome",
  "Color": "Cor",
  "Preview": "Pré-visualização",
  "Save": "Guardar",
  "New cluster": "Novo grupo",
  "Delete cluster": "Apagar grupo",
  "Delete cluster?": "Apagar grupo?",
  "Tasks inside this cluster will move to Drift.":
    "As tarefas deste grupo passam para a Deriva.",
  "Dimmed colors are already used by another cluster.":
    "As cores esbatidas já estão a ser usadas por outro grupo.",
  "Drift": "Deriva",
  "Drift is the catch-all": "A Deriva é o grupo de recolha",
  "Work, Health, Reading…": "Trabalho, Saúde, Leitura…",
  "Organise clusters": "Organizar grupos",
  "Reviewing your universe…": "A analisar o teu universo…",
  "Your universe is already tidy.": "O teu universo já está arrumado.",
  "Try again once you've added a few more tasks.":
    "Tenta de novo depois de adicionares mais algumas tarefas.",
  "Universe updated": "Universo actualizado",
  "Couldn't apply": "Não foi possível aplicar",

  // --- money ------------------------------------------------------------
  "Spent this month": "Gasto este mês",
  "No expenses yet": "Ainda não há despesas",
  "Tap the + button to log your first one.":
    "Toca no botão + para registares a primeira.",
  "Could not load entries": "Não foi possível carregar os registos",
  "New expense": "Nova despesa",
  "Amount": "Valor",
  "Merchant": "Comerciante",
  "Date": "Data",
  "Log expense": "Registar despesa",
  "Tesco, Uber, Netflix…": "Continente, Uber, Netflix…",
  "Entry": "Registo",
  "Entry not found": "Registo não encontrado",
  "Category": "Categoria",
  "Notes": "Notas",
  "Optional context": "Contexto opcional",
  "Delete entry": "Apagar registo",
  "Changing the merchant re-runs categorisation.":
    "Mudar o comerciante volta a correr a categorização.",
  "Today": "Hoje",
  "Yesterday": "Ontem",

  // --- settings ---------------------------------------------------------
  "Settings": "Definições",
  "Profile": "Perfil",
  "Plan": "Plano",
  "See plans →": "Ver planos →",
  "Language": "Idioma",
  "Used for speech recognition and for the language Orbi replies in.":
    "Usado no reconhecimento de voz e no idioma em que o Orbi responde.",
  "Loading…": "A carregar…",
  "Notifications": "Notificações",
  "Push notifications": "Notificações push",
  "Enable in iOS Settings": "Activar nas Definições do iOS",
  "Disable in iOS Settings": "Desactivar nas Definições do iOS",
  "Status": "Estado",
  "API endpoint": "Endpoint da API",
  "Dev tools": "Ferramentas de programação",
  "Register push device": "Registar dispositivo push",
  "Send test push": "Enviar push de teste",
  "Device registered": "Dispositivo registado",
  "Registration failed": "Falha no registo",
  "Test push sent": "Push de teste enviado",
  "Test push failed": "Falha no push de teste",
  "Sign out": "Terminar sessão",
  "Sign out?": "Terminar sessão?",
  "You'll need to sign back in to use Orbi.":
    "Vais precisar de entrar de novo para usar o Orbi.",
  "Ask Orbi to suggest cluster merges, moves, and new groupings.":
    "Pede ao Orbi para sugerir fusões, movimentos e novos grupos.",
  "Removed before launch.": "Removido antes do lançamento.",
  "Notifications were declined earlier. Enable them in iOS Settings → Expo Go → Notifications.":
    "As notificações foram recusadas anteriormente. Activa-as em Definições do iOS → Expo Go → Notificações.",
  "iOS handles notification permissions itself. Disable them in Settings → Expo Go → Notifications.":
    "O iOS gere as permissões de notificação. Desactiva-as em Definições → Expo Go → Notificações.",

  // --- upgrade ----------------------------------------------------------
  "Your plan": "O teu plano",
  "Coming soon": "Em breve",
  "Orbi has three tiers. Pick the one that fits your universe.":
    "O Orbi tem três planos. Escolhe o que se ajusta ao teu universo.",
  "Payments land in Phase 5 via the App Store and Play Store. Sit tight.":
    "Os pagamentos chegam na Fase 5 via App Store e Play Store. Aguarda.",

  // --- long-form hints ---
  "Tap to deselect anything you don't want. Approved changes apply when you tap Apply.":
    "Toca para desmarcar o que não queres. As alterações aprovadas aplicam-se quando tocares em Aplicar.",
  "Orbi looks across every task you have, regardless of cluster. Hold the mic to dictate.":
    "O Orbi procura em todas as tuas tarefas, independentemente do grupo. Mantém o micro premido para ditar.",
  "Drift collects tasks that haven't been assigned to a cluster yet. It can't be renamed, recolored, or deleted. Move tasks out of Drift by editing each one, or use Organise clusters to let Orbi suggest a new home for them.":
    "A Deriva recolhe as tarefas que ainda não foram atribuídas a um grupo. Não pode ser renomeada, recolorida nem apagada. Move as tarefas para fora da Deriva editando cada uma, ou usa Organizar grupos para o Orbi sugerir um novo destino.",
  "Known merchants categorize automatically. Unknowns stay uncategorized on Spark; Pro and Genius use AI to guess.":
    "Comerciantes conhecidos são categorizados automaticamente. Os desconhecidos ficam sem categoria no Spark; o Pro e o Genius usam IA para adivinhar.",
  "Short keyword shown inside the bubble. Auto-suggested from the title — feel free to type your own.":
    "Palavra curta mostrada dentro da bolha. Sugerida a partir do título — escreve a tua se preferires.",
};
