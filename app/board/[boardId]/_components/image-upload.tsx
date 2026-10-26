"use client";

import { useState, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Image as ImageIcon } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "@/hooks/use-translation";
import { useBoardRuntime } from "@/lib/collaboration/react";
import { uploadBoardImage } from "@/lib/board/assets-client";

interface ImageUploadProps {
  onImageUploaded: (imageUrl: string) => void;
}

export const ImageUpload = ({ onImageUploaded }: ImageUploadProps) => {
  const { t } = useTranslation();
  const runtime = useBoardRuntime();
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleClick = () => {
    if (fileInputRef.current) {
      fileInputRef.current.click();
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      setIsUploading(true);
      
      const asset = await uploadBoardImage(runtime.session.board.id, file);
      onImageUploaded(asset.url);
      
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    } catch {
      toast.error(t("imageUpload.error"));
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <>
      <input
        type="file"
        ref={fileInputRef}
        style={{ display: "none" }}
        accept="image/jpeg,image/png,image/gif,image/webp"
        onChange={handleFileChange}
      />
      <Button
        variant={isUploading ? "outline" : "board"}
        size="icon"
        onClick={handleClick}
        disabled={isUploading}
      >
        <ImageIcon />
      </Button>
    </>
  );
};
