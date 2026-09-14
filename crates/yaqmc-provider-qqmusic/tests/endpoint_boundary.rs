//! Conservative AST inventory. Unknown cfg branches remain visible; this is
//! a ratchet for known literals/calls, not proof of complete API decoupling.
use proc_macro2::{TokenStream, TokenTree};
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    path::{Path, PathBuf},
};
use syn::{
    parse::Parser,
    punctuated::Punctuated,
    visit::{self, Visit},
    Attribute, Expr, ForeignItem, ImplItem, Item, Lit, Meta, Token, TraitItem,
};

const MARKERS: &[&str] = &[
    "u.y.qq.com",
    "c.y.qq.com",
    "c6.y.qq.com",
    "api.tencentmusic.com",
    "ssl.ptlogin2",
    "xui.ptlogin2",
    "graph.qq.com",
    "open.weixin.qq.com",
    "musicu.fcg",
    "musics.fcg",
    "fcg_query_lyric",
    "y.qq.com",
];
// Finite counts: file, overlapping literal markers, low-level request calls.
const EXPECTED: &[(&str, usize, usize)] = &[
    ("qmapi/transport.rs", 28, 2),
    ("qqmusic/auth.rs", 22, 8),
    ("qqmusic/oauth.rs", 11, 0),
    ("qqmusic/transport.rs", 12, 3),
    ("qqmusic/transport/qmapi_bridge.rs", 0, 1),
];
#[derive(Clone, Copy, PartialEq, Eq)]
enum Truth {
    Yes,
    No,
    Unknown,
}
fn cfg_truth(meta: &Meta) -> Truth {
    match meta {
        Meta::Path(p) if p.is_ident("test") => Truth::No,
        Meta::List(l)
            if l.path.is_ident("any") || l.path.is_ident("all") || l.path.is_ident("not") =>
        {
            let args = Punctuated::<Meta, Token![,]>::parse_terminated
                .parse2(l.tokens.clone())
                .expect("cfg arguments");
            let values: Vec<_> = args.iter().map(cfg_truth).collect();
            if l.path.is_ident("not") {
                assert_eq!(values.len(), 1);
                return match values[0] {
                    Truth::No => Truth::Yes,
                    Truth::Yes => Truth::No,
                    Truth::Unknown => Truth::Unknown,
                };
            }
            let all = l.path.is_ident("all");
            let decisive = if all { Truth::No } else { Truth::Yes };
            if values.contains(&decisive) {
                decisive
            } else if values.contains(&Truth::Unknown) {
                Truth::Unknown
            } else if all {
                Truth::Yes
            } else {
                Truth::No
            }
        }
        _ => Truth::Unknown,
    }
}
fn meta_active(meta: &Meta) -> bool {
    match meta {
        Meta::List(l) if l.path.is_ident("cfg") => {
            cfg_truth(&syn::parse2::<Meta>(l.tokens.clone()).expect("cfg predicate")) != Truth::No
        }
        Meta::List(l) if l.path.is_ident("cfg_attr") => {
            let args = Punctuated::<Meta, Token![,]>::parse_terminated
                .parse2(l.tokens.clone())
                .expect("cfg_attr arguments");
            let mut args = args.iter();
            cfg_truth(args.next().expect("cfg_attr predicate")) != Truth::Yes
                || args.all(meta_active)
        }
        _ => true,
    }
}
fn active(attrs: &[Attribute]) -> bool {
    attrs.iter().all(|a| meta_active(&a.meta))
}
macro_rules! attributes {
    ($name:ident, $node:ident, $($v:ident),+ $(,)?) => {
        fn $name(node: &$node) -> &[Attribute] { match node { $($node::$v(n)=>&n.attrs,)+ _=>&[] } }
    };
}
attributes!(
    item_attrs,
    Item,
    Const,
    Enum,
    ExternCrate,
    Fn,
    ForeignMod,
    Impl,
    Macro,
    Mod,
    Static,
    Struct,
    Trait,
    TraitAlias,
    Type,
    Union,
    Use
);
attributes!(impl_attrs, ImplItem, Const, Fn, Type, Macro);
attributes!(trait_attrs, TraitItem, Const, Fn, Type, Macro);
attributes!(foreign_attrs, ForeignItem, Fn, Static, Type, Macro);
attributes!(
    expr_attrs, Expr, Array, Assign, Async, Await, Binary, Block, Break, Call, Cast, Closure,
    Const, Continue, Field, ForLoop, Group, If, Index, Infer, Let, Lit, Loop, Macro, Match,
    MethodCall, Paren, Path, Range, RawAddr, Reference, Repeat, Return, Struct, Try, TryBlock,
    Tuple, Unary, Unsafe, While, Yield
);

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct Counts {
    literals: usize,
    requests: usize,
}
fn request_like(name: &str) -> bool {
    matches!(
        name,
        "request_http"
            | "request_http_raw"
            | "request_http_bytes"
            | "request_cgi"
            | "request_cgi_batch"
            | "send_json"
            | "musicu_request"
            | "send"
            | "execute"
    )
}
struct Scan {
    root: PathBuf,
    file: PathBuf,
    module_dir: PathBuf,
    inline_depth: usize,
    seen: HashSet<PathBuf>,
    counts: BTreeMap<String, Counts>,
}
impl Scan {
    fn new(root: &Path) -> Self {
        Self {
            root: root.into(),
            file: root.join("lib.rs"),
            module_dir: root.into(),
            inline_depth: 0,
            seen: HashSet::new(),
            counts: BTreeMap::new(),
        }
    }
    fn current(&mut self) -> &mut Counts {
        let key = self
            .file
            .strip_prefix(&self.root)
            .expect("source inside src")
            .to_string_lossy()
            .replace('\\', "/");
        self.counts.entry(key).or_default()
    }
    fn text(&mut self, value: &str) {
        self.current().literals += MARKERS
            .iter()
            .map(|m| value.matches(m).count())
            .sum::<usize>();
    }
    fn tokens(&mut self, tokens: TokenStream) {
        let mut dot = false;
        for token in tokens {
            match &token {
                TokenTree::Ident(name) if dot && request_like(&name.to_string()) => {
                    self.current().requests += 1
                }
                TokenTree::Literal(t) => {
                    if let Ok(lit) = syn::parse_str::<Lit>(&t.to_string()) {
                        self.visit_lit(&lit);
                    }
                }
                TokenTree::Group(g) => self.tokens(g.stream()),
                _ => {}
            }
            dot = matches!(&token, TokenTree::Punct(p) if p.as_char() == '.');
        }
    }
    fn source(&mut self, file: PathBuf, module_dir: PathBuf) {
        let file = file.canonicalize().expect("declared module exists");
        assert!(file.starts_with(&self.root), "external module escapes src");
        if !self.seen.insert(file.clone()) {
            return;
        }
        let ast = syn::parse_file(&fs::read_to_string(&file).expect("readable source"))
            .expect("valid Rust source");
        if !active(&ast.attrs) {
            return;
        }
        let old_file = std::mem::replace(&mut self.file, file);
        let old_dir = std::mem::replace(&mut self.module_dir, module_dir);
        let old_depth = std::mem::replace(&mut self.inline_depth, 0);
        self.current();
        self.visit_file(&ast);
        self.file = old_file;
        self.module_dir = old_dir;
        self.inline_depth = old_depth;
    }
}
impl<'ast> Visit<'ast> for Scan {
    fn visit_attribute(&mut self, _: &'ast Attribute) {} // Exclude doc and cfg strings.
    fn visit_item(&mut self, n: &'ast Item) {
        if active(item_attrs(n)) {
            assert!(!matches!(n, Item::Verbatim(_)), "unparsed production item");
            visit::visit_item(self, n);
        }
    }
    fn visit_impl_item(&mut self, n: &'ast ImplItem) {
        if active(impl_attrs(n)) {
            assert!(!matches!(n, ImplItem::Verbatim(_)));
            visit::visit_impl_item(self, n);
        }
    }
    fn visit_trait_item(&mut self, n: &'ast TraitItem) {
        if active(trait_attrs(n)) {
            assert!(!matches!(n, TraitItem::Verbatim(_)));
            visit::visit_trait_item(self, n);
        }
    }
    fn visit_foreign_item(&mut self, n: &'ast ForeignItem) {
        if active(foreign_attrs(n)) {
            assert!(!matches!(n, ForeignItem::Verbatim(_)));
            visit::visit_foreign_item(self, n);
        }
    }
    fn visit_expr(&mut self, n: &'ast Expr) {
        if active(expr_attrs(n)) {
            assert!(!matches!(n, Expr::Verbatim(_)));
            visit::visit_expr(self, n);
        }
    }
    fn visit_local(&mut self, n: &'ast syn::Local) {
        if active(&n.attrs) {
            visit::visit_local(self, n);
        }
    }
    fn visit_stmt_macro(&mut self, n: &'ast syn::StmtMacro) {
        if active(&n.attrs) {
            visit::visit_stmt_macro(self, n);
        }
    }
    fn visit_field(&mut self, n: &'ast syn::Field) {
        if active(&n.attrs) {
            visit::visit_field(self, n);
        }
    }
    fn visit_variant(&mut self, n: &'ast syn::Variant) {
        if active(&n.attrs) {
            visit::visit_variant(self, n);
        }
    }
    fn visit_arm(&mut self, n: &'ast syn::Arm) {
        if active(&n.attrs) {
            visit::visit_arm(self, n);
        }
    }
    fn visit_item_mod(&mut self, n: &'ast syn::ItemMod) {
        if !active(&n.attrs) {
            return;
        }
        if let Some((_, items)) = &n.content {
            let old = self.module_dir.clone();
            self.module_dir.push(n.ident.to_string());
            self.inline_depth += 1;
            for item in items {
                self.visit_item(item);
            }
            self.module_dir = old;
            self.inline_depth -= 1;
            return;
        }
        assert!(
            !n.attrs.iter().any(|a| a.path().is_ident("cfg_attr")),
            "conditional external module path needs explicit coverage"
        );
        let explicit = n.attrs.iter().find(|a| a.path().is_ident("path")).map(|a| {
            let Meta::NameValue(value) = &a.meta else {
                panic!("invalid module path")
            };
            let Expr::Lit(value) = &value.value else {
                panic!("nonliteral module path")
            };
            let Lit::Str(value) = &value.lit else {
                panic!("nonstring module path")
            };
            let base = if self.inline_depth == 0 {
                self.file.parent().unwrap()
            } else {
                &self.module_dir
            };
            base.join(value.value())
        });
        let name = n.ident.to_string();
        let path = explicit.unwrap_or_else(|| {
            let flat = self.module_dir.join(format!("{name}.rs"));
            let nested = self.module_dir.join(&name).join("mod.rs");
            assert!(!(flat.exists() && nested.exists()), "ambiguous module");
            if flat.exists() {
                flat
            } else {
                nested
            }
        });
        let nested = if path.file_name().unwrap() == "mod.rs" {
            path.parent().unwrap().to_path_buf()
        } else {
            path.parent().unwrap().join(path.file_stem().unwrap())
        };
        self.source(path, nested);
    }
    fn visit_lit(&mut self, n: &'ast Lit) {
        match n {
            Lit::Str(s) => self.text(&s.value()),
            Lit::ByteStr(s) => self.text(&String::from_utf8_lossy(&s.value())),
            Lit::CStr(s) => self.text(&s.value().to_string_lossy()),
            _ => {}
        }
    }
    fn visit_macro(&mut self, n: &'ast syn::Macro) {
        let name = n.path.segments.last().unwrap().ident.to_string();
        assert!(
            !matches!(
                name.as_str(),
                "include" | "include_str" | "include_bytes" | "cfg_if"
            ),
            "opaque production macro {name} needs source coverage"
        );
        self.tokens(n.tokens.clone());
    }
    fn visit_expr_method_call(&mut self, n: &'ast syn::ExprMethodCall) {
        if request_like(&n.method.to_string()) {
            self.current().requests += 1;
        }
        visit::visit_expr_method_call(self, n);
    }
    fn visit_expr_call(&mut self, n: &'ast syn::ExprCall) {
        if let Expr::Path(p) = n.func.as_ref() {
            if p.path
                .segments
                .last()
                .is_some_and(|s| request_like(&s.ident.to_string()))
            {
                self.current().requests += 1;
            }
        }
        visit::visit_expr_call(self, n);
    }
}

#[test]
fn production_endpoint_inventory_is_finite_and_exact() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("src")
        .canonicalize()
        .unwrap();
    let mut scan = Scan::new(&root);
    scan.source(root.join("lib.rs"), root.clone());
    let observed: BTreeMap<_, _> = scan
        .counts
        .into_iter()
        .filter(|(_, c)| *c != Counts::default())
        .collect();
    let expected: BTreeMap<_, _> = EXPECTED
        .iter()
        .map(|(p, l, r)| {
            (
                p.to_string(),
                Counts {
                    literals: *l,
                    requests: *r,
                },
            )
        })
        .collect();
    assert_eq!(
        observed, expected,
        "endpoint residue changed: inspect delta before changing the finite inventory"
    );
}
fn sample(source: &str) -> Counts {
    let mut scan = Scan::new(Path::new("fixture"));
    scan.visit_file(&syn::parse_file(source).unwrap());
    *scan.current()
}
#[test]
fn test_modules_do_not_hide_following_production_or_raw_literals() {
    let source = r####"
        #[cfg(test)] mod tests { const URL:&str="u.y.qq.com"; }
        // } { "u.y.qq.com"
        /* { "u.y.qq.com" } */
        fn production<'a>(s:&'a str) {
            let _=r###"} u.y.qq.com {"###;
            let _=b"u.y.qq.com";
            call!("u.y.qq.com",r#"{"#);
            #[cfg(test)] let _="u.y.qq.com";
            #[cfg(test)] { let _="u.y.qq.com"; }
            let _='}';
        }
    "####;
    assert_eq!(
        sample(source),
        Counts {
            literals: 6,
            requests: 0
        }
    );
}
#[test]
fn cfg_keeps_unknown_feature_branches() {
    assert_eq!(
        sample(
            r#"
        #[cfg(any(test, feature="live"))] const A:&str="u.y.qq.com";
        #[cfg(all(test, feature="live"))] const B:&str="u.y.qq.com";
        #[cfg(not(test))] const C:&str="u.y.qq.com";
        #[cfg_attr(not(test), cfg(test))] const D:&str="u.y.qq.com";
        #[cfg_attr(feature="live", cfg(test))] const E:&str="u.y.qq.com";
        #[cfg(any())] const F:&str="u.y.qq.com";
    "#
        )
        .literals,
        6
    );
}
#[test]
fn external_test_modules_do_not_hide_production_test_named_files() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    fs::write(
        root.join("lib.rs"),
        "#[cfg(test)] mod missing_tests; mod active_tests; const URL:&str=\"u.y.qq.com\";",
    )
    .unwrap();
    fs::write(
        root.join("active_tests.rs"),
        "const URL:&str=\"u.y.qq.com\";",
    )
    .unwrap();
    let mut scan = Scan::new(&root);
    scan.source(root.join("lib.rs"), root.clone());
    assert_eq!(scan.counts["lib.rs"].literals, 2);
    assert_eq!(scan.counts["active_tests.rs"].literals, 2);
}
#[test]
#[should_panic(expected = "opaque production macro")]
fn generated_code_is_not_silently_skipped() {
    sample("include!(concat!(env!(\"OUT_DIR\"), \"/routes.rs\"));");
}
#[test]
fn low_level_calls_are_detected_without_url_literals() {
    assert_eq!(
        sample("fn f(c:C) { c.request_cgi(module,method,payload); #[cfg(test)] c.send(); }")
            .requests,
        1
    );
    assert_eq!(
        sample("fn f(c:C) { select! { x=c.request_http(url) => {} } C::request_cgi(c,m,p); }")
            .requests,
        2
    );
}

#[test]
fn cfg_on_associated_items_and_match_arms_is_respected() {
    assert_eq!(
        sample(
            r#"
        struct A;
        impl A {
            #[cfg(test)] fn hidden() { let _="u.y.qq.com"; }
            fn visible() { let _="u.y.qq.com"; }
        }
        trait T {
            #[cfg(test)] const HIDDEN: &str = "u.y.qq.com";
            const VISIBLE: &str = "u.y.qq.com";
        }
        fn f() { match x {
            #[cfg(test)] 1 => "u.y.qq.com",
            _ => "u.y.qq.com",
        }; }
    "#
        )
        .literals,
        6
    );
}

#[test]
fn inline_modules_resolve_explicit_paths_without_skipping_their_files() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    fs::create_dir(root.join("nested")).unwrap();
    fs::write(
        root.join("lib.rs"),
        r#"mod nested { #[path="other.rs"] mod aliases; }"#,
    )
    .unwrap();
    fs::write(
        root.join("nested/other.rs"),
        "const URL: &str = \"u.y.qq.com\";",
    )
    .unwrap();
    let mut scan = Scan::new(&root);
    scan.source(root.join("lib.rs"), root.clone());
    assert_eq!(scan.counts["nested/other.rs"].literals, 2);
}

#[test]
fn adding_a_marker_to_a_known_owner_changes_the_frozen_inventory() {
    let source = "fn a() { let _=\"u.y.qq.com\"; }";
    let baseline = sample(source);
    assert_ne!(
        baseline,
        sample(&format!("{source}\nconst NEW: &str=\"graph.qq.com\";"))
    );
}
