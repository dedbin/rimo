import { Plus } from "lucide-react";
import { OrganizationProfile } from "@clerk/nextjs";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export const InviteButton = () => {
    return (
        <Dialog>
            <DialogTrigger asChild>
                <Button variant="outline">
                    <Plus className="h-4 w-4 mr-2" />
                    Invite members
                </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-[930px] justify-center">
                <DialogTitle className="text-lg font-semibold">
                    Invite members
                </DialogTitle>
                <OrganizationProfile routing="hash"/>
            </DialogContent>
        </Dialog>
    );
};