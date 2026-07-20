"use client";

import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Underline } from "@tiptap/extension-underline";
import { TextStyle } from "@tiptap/extension-text-style";
import { FontSize } from "@tiptap/extension-text-style/font-size";
import { Color } from "@tiptap/extension-color";
import { Highlight } from "@tiptap/extension-highlight";
import { TextAlign } from "@tiptap/extension-text-align";
import { Link } from "@tiptap/extension-link";
import { Placeholder } from "@tiptap/extension-placeholder";
import Image from "@tiptap/extension-image";
import { useState, useEffect, useCallback, useRef } from "react";
import type { EditorView } from "@tiptap/pm/view";
import {
  Bold,
  Italic,
  Underline as UnderlineIcon,
  Strikethrough,
  List,
  ListOrdered,
  AlignLeft,
  AlignCenter,
  AlignRight,
  Link as LinkIcon,
  Highlighter,
  Type,
  Palette,
  Undo2,
  Redo2,
  Minus,
} from "lucide-react";

/** Read image file → data URL and insert into the editor view. */
function insertImageFile(view: EditorView, file: File): boolean {
  if (!file.type.startsWith("image/")) return false;
  const reader = new FileReader();
  reader.onload = () => {
    const src = reader.result as string;
    if (!src || typeof src !== "string") return;
    const { schema } = view.state;
    const imageType = schema.nodes.image;
    if (!imageType) return;
    const node = imageType.create({ src, alt: file.name || "image" });
    const tr = view.state.tr.replaceSelectionWith(node).scrollIntoView();
    view.dispatch(tr);
  };
  reader.readAsDataURL(file);
  return true;
}

function handleImageClipboard(view: EditorView, event: ClipboardEvent | DragEvent): boolean {
  const data =
    "clipboardData" in event && event.clipboardData
      ? event.clipboardData
      : "dataTransfer" in event
        ? event.dataTransfer
        : null;
  if (!data) return false;

  // Prefer file items (Cmd+V of a copied image / screenshot)
  const items = data.items ? Array.from(data.items) : [];
  for (const item of items) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file) {
        event.preventDefault();
        insertImageFile(view, file);
        return true;
      }
    }
  }

  // Fallback: files list (some browsers / drag-drop)
  const files = data.files ? Array.from(data.files) : [];
  for (const file of files) {
    if (file.type.startsWith("image/")) {
      event.preventDefault();
      insertImageFile(view, file);
      return true;
    }
  }

  return false;
}

interface RichEditorProps {
  initialContent?: string;
  placeholder?: string;
  onHtmlChange: (html: string) => void;
  onTextChange: (text: string) => void;
  /** Hands the Tiptap editor instance to the parent (signature swapping). */
  onEditorReady?: (editor: Editor) => void;
}

const COLORS = [
  "#FFFFFF", "#D1D5DB", "#9CA3AF", "var(--mc-accent)", "#3B82F6",
  "#8B5CF6", "#EC4899", "#EF4444", "#F59E0B", "#10B981",
];

const HIGHLIGHT_COLORS = [
  "var(--mc-warning)40", "var(--mc-danger)40", "var(--mc-accent)40", "#8B5CF640", "#10B98140",
];

const FONT_SIZES = [
  { label: "Small", size: "12px" },
  { label: "Normal", size: "14px" },
  { label: "Medium", size: "16px" },
  { label: "Large", size: "20px" },
  { label: "XL", size: "24px" },
];

// All toolbar buttons get tabIndex={-1} so Tab skips the entire toolbar
function ToolbarButton({
  active,
  onClick,
  children,
  title,
}: {
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
  title: string;
}) {
  return (
    <button
      onClick={(e) => {
        e.preventDefault(); // Don't steal focus
        onClick();
      }}
      onMouseDown={(e) => e.preventDefault()} // Keep editor focused
      tabIndex={-1}
      title={title}
      className={`p-1.5 rounded transition-colors ${
        active
          ? "bg-mc-teal-dim text-mc-teal"
          : "text-muted-foreground hover:text-foreground hover:bg-muted/40"
      }`}
    >
      {children}
    </button>
  );
}

function ColorPicker({
  colors,
  onSelect,
  activeColor,
}: {
  colors: string[];
  onSelect: (color: string) => void;
  activeColor?: string;
}) {
  return (
    <div className="flex gap-1 p-1.5">
      {colors.map((color) => (
        <button
          key={color}
          onClick={(e) => { e.preventDefault(); onSelect(color); }}
          onMouseDown={(e) => e.preventDefault()}
          tabIndex={-1}
          className={`w-5 h-5 rounded-full border-2 transition-transform hover:scale-110 ${
            activeColor === color ? "border-mc-teal scale-110" : "border-transparent"
          }`}
          style={{ backgroundColor: color }}
          title={color}
        />
      ))}
    </div>
  );
}

export function RichEditor({ initialContent, placeholder, onHtmlChange, onTextChange, onEditorReady }: RichEditorProps) {
  const [showColors, setShowColors] = useState(false);
  const [showHighlight, setShowHighlight] = useState(false);
  const [showFontSize, setShowFontSize] = useState(false);
  const toolbarRef = useRef<HTMLDivElement>(null);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: false,
      }),
      Underline,
      TextStyle,
      FontSize,
      Color,
      Highlight.configure({ multicolor: true }),
      TextAlign.configure({ types: ["paragraph"] }),
      Link.configure({ openOnClick: false }),
      Image.configure({
        inline: false,
        allowBase64: true,
        HTMLAttributes: {
          class: "compose-inline-image",
        },
      }),
      Placeholder.configure({
        placeholder: placeholder || "Write your message...",
      }),
    ],
    content: initialContent || "",
    editorProps: {
      attributes: {
        class:
          "prose prose-neutral dark:prose-invert max-w-none px-4 py-3 min-h-[200px] focus:outline-none text-[13px] leading-relaxed text-secondary-foreground",
      },
      handlePaste: (view, event) => handleImageClipboard(view, event),
      handleDrop: (view, event) => {
        if (!event.dataTransfer?.files?.length) return false;
        return handleImageClipboard(view, event);
      },
    },
    onUpdate: ({ editor }) => {
      onHtmlChange(editor.getHTML());
      onTextChange(editor.getText());
    },
  });

  // Update content if initialContent changes (reply/forward)
  useEffect(() => {
    if (editor && initialContent && editor.getHTML() !== initialContent) {
      editor.commands.setContent(initialContent);
    }
  }, [initialContent, editor]);

  useEffect(() => {
    if (editor && onEditorReady) onEditorReady(editor);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  // Close dropdowns when clicking outside
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (toolbarRef.current && !toolbarRef.current.contains(e.target as Node)) {
        setShowColors(false);
        setShowHighlight(false);
        setShowFontSize(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const setLink = useCallback(() => {
    if (!editor) return;
    const url = window.prompt("URL:", "https://");
    if (url) {
      editor.chain().focus().setLink({ href: url }).run();
    } else {
      editor.chain().focus().unsetLink().run();
    }
  }, [editor]);

  if (!editor) return null;

  return (
    <div className="flex flex-col">
      {/* Toolbar — entire bar is tabIndex={-1}, Tab goes straight to editor */}
      <div
        ref={toolbarRef}
        className="flex items-center gap-0.5 px-3 py-1.5 border-b border-border/60 flex-wrap"
        role="toolbar"
        aria-label="Formatting"
      >
        <ToolbarButton onClick={() => editor.chain().focus().undo().run()} title="Undo (⌘Z)">
          <Undo2 className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton onClick={() => editor.chain().focus().redo().run()} title="Redo (⌘⇧Z)">
          <Redo2 className="h-3.5 w-3.5" />
        </ToolbarButton>

        <div className="w-px h-4 bg-muted/40 mx-1" />

        <ToolbarButton active={editor.isActive("bold")} onClick={() => editor.chain().focus().toggleBold().run()} title="Bold (⌘B)">
          <Bold className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton active={editor.isActive("italic")} onClick={() => editor.chain().focus().toggleItalic().run()} title="Italic (⌘I)">
          <Italic className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton active={editor.isActive("underline")} onClick={() => editor.chain().focus().toggleUnderline().run()} title="Underline (⌘U)">
          <UnderlineIcon className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton active={editor.isActive("strike")} onClick={() => editor.chain().focus().toggleStrike().run()} title="Strikethrough">
          <Strikethrough className="h-3.5 w-3.5" />
        </ToolbarButton>

        <div className="w-px h-4 bg-muted/40 mx-1" />

        {/* Text color */}
        <div className="relative">
          <ToolbarButton
            onClick={() => { setShowColors(!showColors); setShowHighlight(false); setShowFontSize(false); }}
            title="Text Color"
          >
            <Palette className="h-3.5 w-3.5" />
          </ToolbarButton>
          {showColors && (
            <div className="absolute top-full left-0 mt-1 bg-[var(--mc-bg-elevated)] border border-border rounded-lg shadow-xl z-50">
              <ColorPicker
                colors={COLORS}
                onSelect={(c) => { editor.chain().focus().setColor(c).run(); setShowColors(false); }}
                activeColor={editor.getAttributes("textStyle").color}
              />
            </div>
          )}
        </div>

        {/* Highlight */}
        <div className="relative">
          <ToolbarButton
            active={editor.isActive("highlight")}
            onClick={() => { setShowHighlight(!showHighlight); setShowColors(false); setShowFontSize(false); }}
            title="Highlight"
          >
            <Highlighter className="h-3.5 w-3.5" />
          </ToolbarButton>
          {showHighlight && (
            <div className="absolute top-full left-0 mt-1 bg-[var(--mc-bg-elevated)] border border-border rounded-lg shadow-xl z-50">
              <ColorPicker
                colors={HIGHLIGHT_COLORS}
                onSelect={(c) => { editor.chain().focus().toggleHighlight({ color: c }).run(); setShowHighlight(false); }}
              />
            </div>
          )}
        </div>

        <div className="w-px h-4 bg-muted/40 mx-1" />

        {/* Font size */}
        <div className="relative">
          <ToolbarButton
            onClick={() => { setShowFontSize(!showFontSize); setShowColors(false); setShowHighlight(false); }}
            title="Font Size"
          >
            <Type className="h-3.5 w-3.5" />
          </ToolbarButton>
          {showFontSize && (
            <div className="absolute top-full left-0 mt-1 bg-[var(--mc-bg-elevated)] border border-border rounded-lg shadow-xl z-50 py-1 min-w-[100px]">
              {FONT_SIZES.map((fs) => (
                <button
                  key={fs.size}
                  onMouseDown={(e) => e.preventDefault()}
                  tabIndex={-1}
                  onClick={() => {
                    editor.chain().focus().setFontSize(fs.size).run();
                    setShowFontSize(false);
                  }}
                  className="w-full text-left px-3 py-1.5 text-[12px] text-secondary-foreground hover:bg-muted/40 transition-colors"
                  style={{ fontSize: fs.size }}
                >
                  {fs.label}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="w-px h-4 bg-muted/40 mx-1" />

        <ToolbarButton active={editor.isActive({ textAlign: "left" })} onClick={() => editor.chain().focus().setTextAlign("left").run()} title="Align Left">
          <AlignLeft className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton active={editor.isActive({ textAlign: "center" })} onClick={() => editor.chain().focus().setTextAlign("center").run()} title="Align Center">
          <AlignCenter className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton active={editor.isActive({ textAlign: "right" })} onClick={() => editor.chain().focus().setTextAlign("right").run()} title="Align Right">
          <AlignRight className="h-3.5 w-3.5" />
        </ToolbarButton>

        <div className="w-px h-4 bg-muted/40 mx-1" />

        <ToolbarButton active={editor.isActive("bulletList")} onClick={() => editor.chain().focus().toggleBulletList().run()} title="Bullet List">
          <List className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton active={editor.isActive("orderedList")} onClick={() => editor.chain().focus().toggleOrderedList().run()} title="Numbered List">
          <ListOrdered className="h-3.5 w-3.5" />
        </ToolbarButton>

        <div className="w-px h-4 bg-muted/40 mx-1" />

        <ToolbarButton active={editor.isActive("link")} onClick={setLink} title="Insert Link">
          <LinkIcon className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton onClick={() => editor.chain().focus().setHorizontalRule().run()} title="Divider">
          <Minus className="h-3.5 w-3.5" />
        </ToolbarButton>
      </div>

      {/* Editor */}
      <EditorContent editor={editor} />

      {/* Styles */}
      <style jsx global>{`
        .tiptap {
          min-height: 200px;
          outline: none;
        }
        .tiptap p.is-editor-empty:first-child::before {
          content: attr(data-placeholder);
          float: left;
          color: #4B5563;
          pointer-events: none;
          height: 0;
        }
        .tiptap p {
          margin: 0.25em 0;
        }
        .tiptap ul, .tiptap ol {
          padding-left: 1.5em;
          margin: 0.5em 0;
        }
        .tiptap a {
          color: var(--mc-accent);
          text-decoration: underline;
        }
        .tiptap mark {
          border-radius: 2px;
          padding: 0 2px;
        }
        .tiptap hr {
          border-color: rgba(255,255,255,0.1);
          margin: 0.75em 0;
        }
        .tiptap blockquote {
          border-left: 3px solid rgba(255,255,255,0.1);
          padding-left: 1em;
          margin: 0.5em 0;
          color: #9CA3AF;
        }
        .tiptap img.compose-inline-image,
        .tiptap img {
          max-width: 100%;
          height: auto;
          border-radius: 6px;
          margin: 0.5em 0;
          display: block;
        }
      `}</style>
    </div>
  );
}
